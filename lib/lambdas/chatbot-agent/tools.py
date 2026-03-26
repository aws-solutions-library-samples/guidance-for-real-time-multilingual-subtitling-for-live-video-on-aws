import os
import boto3
from strands import tool

dynamodb = boto3.resource('dynamodb')
lambda_client = boto3.client('lambda')
table = dynamodb.Table(os.environ.get('LANGUAGE_CONFIG_TABLE', 'LanguageConfigTable'))
WEBVTT_LAMBDA_NAME = os.environ.get('WEBVTT_LAMBDA_NAME', '')


@tool
def list_languages() -> dict:
    """List all subtitle languages with their activation status.
    Returns active languages currently producing subtitles and available languages that can be added."""
    response = table.scan()
    items = response.get('Items', [])

    active = sorted([i for i in items if i.get('active')], key=lambda x: x['segment_id'])
    available = sorted([i for i in items if not i.get('active')], key=lambda x: x['segment_id'])

    return {
        'active': [{'code': i['language_code'], 'name': i['name']} for i in active],
        'available': [{'code': i['language_code'], 'name': i['name']} for i in available],
        'used_slots': len(active),
        'total_slots': len(items)
    }


@tool
def add_language(language_code: str) -> dict:
    """Activate a subtitle language so it starts producing translated subtitles.

    Args:
        language_code: ISO 639-1 language code (e.g. 'ko' for Korean, 'ja' for Japanese)
    """
    resp = table.get_item(Key={'language_code': language_code})
    item = resp.get('Item')
    if not item:
        return {'error': f'Unknown language code: {language_code}'}
    if item.get('active'):
        return {'error': f'{item["name"]} is already active'}

    table.update_item(
        Key={'language_code': language_code},
        UpdateExpression='SET active = :val',
        ExpressionAttributeValues={':val': True}
    )

    verified = _rebuild_language_mapping(language_code, should_be_active=True)

    return {
        'language_code': language_code,
        'name': item['name'],
        'status': 'active',
        'verified': verified
    }


@tool
def remove_language(language_code: str) -> dict:
    """Deactivate a subtitle language so it stops producing translated subtitles.

    Args:
        language_code: ISO 639-1 language code (e.g. 'ko' for Korean, 'ja' for Japanese)
    """
    if language_code == 'en':
        return {'error': 'Cannot remove source language (en). English is the source language.'}

    resp = table.get_item(Key={'language_code': language_code})
    item = resp.get('Item')
    if not item:
        return {'error': f'Unknown language code: {language_code}'}
    if not item.get('active'):
        return {'error': f'{item["name"]} is already inactive'}

    table.update_item(
        Key={'language_code': language_code},
        UpdateExpression='SET active = :val',
        ExpressionAttributeValues={':val': False}
    )

    verified = _rebuild_language_mapping(language_code, should_be_active=False)

    return {
        'language_code': language_code,
        'name': item['name'],
        'status': 'inactive',
        'verified': verified
    }


@tool
def get_system_status() -> dict:
    """Get system status including slot usage and active language count."""
    response = table.scan()
    items = response.get('Items', [])

    active = [i for i in items if i.get('active')]

    return {
        'used_slots': len(active),
        'total_slots': len(items),
        'available_slots': len(items) - len(active),
        'active_languages': [{'code': i['language_code'], 'name': i['name']} for i in sorted(active, key=lambda x: x['segment_id'])]
    }


def _rebuild_language_mapping(changed_code, should_be_active):
    """Rebuild LANGUAGE_MAPPING env var on WebVTT Lambda after language change."""
    if not WEBVTT_LAMBDA_NAME:
        return False

    import time

    result = table.scan(
        FilterExpression='active = :active',
        ExpressionAttributeValues={':active': True}
    )

    active_languages = sorted(result.get('Items', []), key=lambda x: x['segment_id'])
    new_mapping = ','.join(f"{l['segment_id']}-{l['language_code']}" for l in active_languages)

    current_config = lambda_client.get_function_configuration(FunctionName=WEBVTT_LAMBDA_NAME)
    current_env = current_config.get('Environment', {}).get('Variables', {})
    current_env['LANGUAGE_MAPPING'] = new_mapping

    lambda_client.update_function_configuration(
        FunctionName=WEBVTT_LAMBDA_NAME,
        Environment={'Variables': current_env}
    )

    for attempt in range(3):
        time.sleep(1)
        updated_config = lambda_client.get_function_configuration(FunctionName=WEBVTT_LAMBDA_NAME)
        updated_mapping = updated_config.get('Environment', {}).get('Variables', {}).get('LANGUAGE_MAPPING', '')
        last_status = updated_config.get('LastUpdateStatus', '')

        if should_be_active:
            if f'-{changed_code}' in updated_mapping and last_status == 'Successful':
                return True
        else:
            if f'-{changed_code}' not in updated_mapping and last_status == 'Successful':
                return True

    return False
