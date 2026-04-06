import os
import time
import boto3
from strands import tool

dynamodb = boto3.resource('dynamodb')

table = dynamodb.Table(os.environ.get('LANGUAGE_CONFIG_TABLE', 'LanguageConfigTable'))
subtitle_table = dynamodb.Table(os.environ.get('DYNAMODB_TABLE', 'SubtitleTable'))


# Special keys in LanguageConfigTable that are not language entries
_SPECIAL_KEYS = {'SETTINGS', 'TRANSLATION_DICT', 'SCREEN_MAPPING', 'VOCABULARY', 'MODEL_SETTINGS'}

# Module-level state for pending screen (read by handler.py after agent completes)
_pending_screen = None


def _is_language_item(item):
    return item.get('language_code') not in _SPECIAL_KEYS and 'segment_id' in item


@tool
def list_languages() -> dict:
    """List all subtitle languages with their activation status.
    Returns active languages currently producing subtitles and available languages that can be added."""
    response = table.scan()
    items = [i for i in response.get('Items', []) if _is_language_item(i)]

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

    return {
        'language_code': language_code,
        'name': item['name'],
        'status': 'active'
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

    return {
        'language_code': language_code,
        'name': item['name'],
        'status': 'inactive'
    }


@tool
def get_system_status() -> dict:
    """Get system status including slot usage and active language count."""
    response = table.scan()
    items = [i for i in response.get('Items', []) if _is_language_item(i)]

    active = [i for i in items if i.get('active')]

    return {
        'used_slots': len(active),
        'total_slots': len(items),
        'available_slots': len(items) - len(active),
        'active_languages': [{'code': i['language_code'], 'name': i['name']} for i in sorted(active, key=lambda x: x['segment_id'])]
    }


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
def set_screen_language(screen_id: str, language_code: str) -> dict:
    """Assign a subtitle language to a specific screen display (1-4).
    Checks if subtitle data exists before switching. If no data yet, returns
    status 'pending' so the frontend can poll and notify when ready.

    Args:
        screen_id: Screen number, must be '1', '2', '3', or '4'
        language_code: ISO 639-1 language code (e.g. 'ko' for Korean, 'de' for German)
    """
    if screen_id not in ['1', '2', '3', '4']:
        return {'error': 'screen_id must be 1, 2, 3, or 4'}

    resp = table.get_item(Key={'language_code': language_code})
    item = resp.get('Item')
    if not item:
        return {'error': f'Unknown language code: {language_code}'}
    if not item.get('active'):
        return {'error': f'{item["name"]} is not active. Call add_language first.'}

    global _pending_screen

    # Check if this language already has enough recent subtitle data
    # If yes → switch immediately. If no → pending flow with polling.
    now_ms = int(time.time() * 1000)
    recent = subtitle_table.query(
        IndexName='id_lang-created_time-index',
        KeyConditionExpression='id_lang = :lang AND created_time > :since',
        ExpressionAttributeValues={':lang': language_code, ':since': now_ms - 30000},
        Limit=3,
        ScanIndexForward=False
    )
    has_recent_data = len(recent.get('Items', [])) >= 3

    if has_recent_data:
        # Language already producing subtitles — switch immediately
        mapping = _get_current_screen_mapping()
        mapping[screen_id] = language_code
        table.put_item(Item={
            'language_code': 'SCREEN_MAPPING',
            'setting_name': 'screen_language_mapping',
            'mapping': mapping,
            'active': False
        })
        return {
            'screen_id': screen_id,
            'language_code': language_code,
            'language_name': item['name'],
            'status': 'assigned',
            'screen_mapping': mapping
        }
    else:
        # New or inactive language — wait for data via polling
        table.update_item(
            Key={'language_code': language_code},
            UpdateExpression='SET needs_pending_screen = :flag, screen_requested_at = :ts',
            ExpressionAttributeValues={':flag': True, ':ts': now_ms}
        )
        mapping = _get_current_screen_mapping()
        _pending_screen = {'screen_id': screen_id, 'language_code': language_code}
        return {
            'screen_id': screen_id,
            'language_code': language_code,
            'language_name': item['name'],
            'status': 'pending',
            'pending_screen': _pending_screen,
            'screen_mapping': mapping
        }


@tool
def get_screen_mapping() -> dict:
    """Get the current screen-to-language mapping showing which language is displayed on each screen."""
    mapping = _get_current_screen_mapping()

    result = {}
    for screen_id, lang_code in mapping.items():
        resp = table.get_item(Key={'language_code': lang_code})
        item = resp.get('Item')
        result[screen_id] = {
            'language_code': lang_code,
            'language_name': item['name'] if item else lang_code
        }

    return {'screen_mapping': result}


def _get_current_screen_mapping():
    """Helper to read screen mapping from DynamoDB."""
    try:
        resp = table.get_item(Key={'language_code': 'SCREEN_MAPPING'})
        mapping = resp.get('Item', {}).get('mapping')
        if mapping:
            return dict(mapping)
    except Exception:
        pass
    return {'1': 'en', '2': 'de', '3': 'es', '4': 'it'}




@tool
def set_translation_model(model_id: str) -> dict:
    """Set the Bedrock model used for subtitle translation.

    Args:
        model_id: Full Bedrock model ID. Valid options:
                  - 'us.amazon.nova-lite-v1:0' (fast and efficient)
                  - 'us.amazon.nova-micro-v1:0' (ultra-low latency, fastest)
                  - 'us.amazon.nova-pro-v1:0' (balanced quality and speed)
                  - 'us.anthropic.claude-haiku-4-5-20251001-v1:0' (highest quality)
    """
    valid_models = [
        'us.amazon.nova-lite-v1:0',
        'us.amazon.nova-micro-v1:0',
        'us.amazon.nova-pro-v1:0',
        'us.anthropic.claude-haiku-4-5-20251001-v1:0'
    ]

    if model_id not in valid_models:
        return {
            'error': f'Invalid model ID. Must be one of: {", ".join(valid_models)}',
            'current_model': None
        }

    try:
        # Store translation model in LANGUAGE_CONFIG_TABLE using special key
        table.put_item(Item={
            'language_code': 'MODEL_SETTINGS',
            'setting_name': 'translation_model',
            'value': model_id,
            'active': False  # Not a language, just a setting
        })

        return {
            'model_id': model_id,
            'status': 'updated',
            'message': f'Translation model set to {model_id}. All new translations will use this model.'
        }
    except Exception as e:
        return {'error': f'Failed to update model: {str(e)}'}


@tool
def get_translation_model() -> dict:
    """Get the currently configured translation model."""
    try:
        resp = table.get_item(Key={'language_code': 'MODEL_SETTINGS'})
        model_id = resp.get('Item', {}).get('value', 'us.amazon.nova-micro-v1:0')

        return {
            'model_id': model_id,
            'status': 'active'
        }
    except Exception as e:
        return {
            'model_id': 'us.amazon.nova-micro-v1:0',
            'error': str(e)
        }
