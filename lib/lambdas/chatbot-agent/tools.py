import os
import boto3
from strands import tool
from decimal import Decimal

dynamodb = boto3.resource('dynamodb')
lambda_client = boto3.client('lambda')
s3_client = boto3.client('s3')
transcribe_client = boto3.client('transcribe')

table = dynamodb.Table(os.environ.get('LANGUAGE_CONFIG_TABLE', 'LanguageConfigTable'))
subtitle_table = dynamodb.Table(os.environ.get('DYNAMODB_TABLE', 'SubtitleTable'))
WEBVTT_LAMBDA_NAME = os.environ.get('WEBVTT_LAMBDA_NAME', '')
VOCABULARY_BUCKET = os.environ.get('VOCABULARY_BUCKET', '')
VOCABULARY_NAME = os.environ.get('VOCABULARY_NAME', 'custom-vocabulary')


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


@tool
def set_translation_style(style: str) -> dict:
    """Set the translation style for all subtitle translations.

    Args:
        style: Translation style - must be one of: 'formal', 'casual', 'technical', 'energetic'
    """
    valid_styles = ['formal', 'casual', 'technical', 'energetic']
    style_lower = style.lower()

    if style_lower not in valid_styles:
        return {
            'error': f'Invalid style. Must be one of: {", ".join(valid_styles)}',
            'current_style': None
        }

    try:
        # Store translation style in LANGUAGE_CONFIG_TABLE using special key
        table.put_item(Item={
            'language_code': 'SETTINGS',
            'setting_name': 'translation_style',
            'value': style_lower,
            'active': False  # Not a language, just a setting
        })

        return {
            'style': style_lower,
            'status': 'updated',
            'message': f'Translation style set to {style_lower}. All new translations will use this style.'
        }
    except Exception as e:
        return {'error': f'Failed to update style: {str(e)}'}


@tool
def add_translation_mapping(original_term: str, target_language: str, translated_term: str) -> dict:
    """Add a translation mapping to control how specific terms are translated.

    Args:
        original_term: The original English term (e.g., 'Messi', 'goal')
        target_language: Target language code (e.g., 'ko' for Korean, 'ja' for Japanese)
        translated_term: How the term should be translated (e.g., '리오넬 메시', '득점')
    """
    if not original_term or not original_term.strip():
        return {'error': 'Original term cannot be empty'}
    if not target_language or not target_language.strip():
        return {'error': 'Target language cannot be empty'}
    if not translated_term or not translated_term.strip():
        return {'error': 'Translated term cannot be empty'}

    original_term = original_term.strip()
    target_language = target_language.lower().strip()
    translated_term = translated_term.strip()

    try:
        # Get current translation dictionary
        resp = table.get_item(Key={'language_code': 'TRANSLATION_DICT'})
        mappings = resp.get('Item', {}).get('mappings', {})

        # Initialize language if doesn't exist
        if target_language not in mappings:
            mappings[target_language] = {}

        # Add or update mapping
        mappings[target_language][original_term] = translated_term

        # Save to DynamoDB
        table.put_item(Item={
            'language_code': 'TRANSLATION_DICT',
            'setting_name': 'term_mappings',
            'mappings': mappings,
            'active': False
        })

        return {
            'original_term': original_term,
            'target_language': target_language,
            'translated_term': translated_term,
            'status': 'added',
            'message': f'Added mapping: "{original_term}" → [{target_language}] "{translated_term}"'
        }
    except Exception as e:
        return {'error': f'Failed to add translation mapping: {str(e)}'}


@tool
def get_translation_mappings(language_code: str = None) -> dict:
    """Get translation mappings for a specific language or all languages.

    Args:
        language_code: Optional language code (e.g., 'ko'). If not provided, returns all mappings.
    """
    try:
        resp = table.get_item(Key={'language_code': 'TRANSLATION_DICT'})
        all_mappings = resp.get('Item', {}).get('mappings', {})

        if language_code:
            language_code = language_code.lower().strip()
            mappings = all_mappings.get(language_code, {})
            return {
                'language': language_code,
                'mappings': mappings,
                'total_terms': len(mappings)
            }
        else:
            # Return all languages
            return {
                'all_mappings': all_mappings,
                'languages': list(all_mappings.keys())
            }
    except Exception as e:
        return {
            'mappings': {},
            'error': str(e)
        }


@tool
def search_subtitles(query: str, language_code: str = None) -> dict:
    """Search subtitle content across all languages and return matching segments with timestamps.
    Automatically searches all active languages if no specific language is provided.
    Supports searching in any language including Korean, Japanese, etc.

    Args:
        query: Text to search for in subtitles (any language)
        language_code: Optional language to search in (e.g. 'ko', 'en'). If not provided, searches all languages.
    """
    if not query or not query.strip():
        return {'error': 'Search query cannot be empty', 'results': []}

    query_lower = query.strip().lower()

    try:
        # If language_code specified, filter by it; otherwise scan all
        if language_code:
            response = subtitle_table.scan(
                FilterExpression='id_lang = :lang',
                ExpressionAttributeValues={':lang': language_code}
            )
        else:
            response = subtitle_table.scan()

        items = response.get('Items', [])

        # Handle pagination for large tables
        while 'LastEvaluatedKey' in response:
            if language_code:
                response = subtitle_table.scan(
                    FilterExpression='id_lang = :lang',
                    ExpressionAttributeValues={':lang': language_code},
                    ExclusiveStartKey=response['LastEvaluatedKey']
                )
            else:
                response = subtitle_table.scan(
                    ExclusiveStartKey=response['LastEvaluatedKey']
                )
            items.extend(response.get('Items', []))

        # Search for query in content
        matches = []
        for item in items:
            content = item.get('content', '')
            if query_lower in content.lower():
                start_time = float(item.get('start_time', 0))
                end_time = float(item.get('end_time', 0))

                matches.append({
                    'content': content,
                    'start_time': start_time,
                    'end_time': end_time,
                    'language': item.get('id_lang', 'unknown'),
                    'created_time': item.get('create_htime', '')
                })

        # Sort by start_time
        matches.sort(key=lambda x: x['start_time'])

        # Limit to 50 results
        matches = matches[:50]

        return {
            'query': query,
            'language': language_code or 'all',
            'results': matches,
            'total_found': len(matches)
        }
    except Exception as e:
        return {
            'error': f'Search failed: {str(e)}',
            'results': []
        }
