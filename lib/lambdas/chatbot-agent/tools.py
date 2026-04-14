import os
import time
import random
import boto3
from strands import tool

dynamodb = boto3.resource('dynamodb')

table = dynamodb.Table(os.environ.get('LANGUAGE_CONFIG_TABLE', 'LanguageConfigTable'))
subtitle_table = dynamodb.Table(os.environ.get('DYNAMODB_TABLE', 'SubtitleTable'))


# Special keys in LanguageConfigTable that are not language entries
_SPECIAL_KEYS = {'SETTINGS', 'TRANSLATION_DICT', 'SCREEN_MAPPING', 'VOCABULARY', 'MODEL_SETTINGS', 'SOURCE_LANGUAGE'}

# Amazon Transcribe Streaming supported languages (language_code → display name)
TRANSCRIBE_LANGUAGES = {
    'en-US': 'English (US)', 'en-GB': 'English (UK)', 'en-AU': 'English (Australia)',
    'en-IN': 'English (India)', 'en-IE': 'English (Ireland)', 'en-AB': 'English (Scottish)',
    'en-ZA': 'English (South Africa)', 'en-NZ': 'English (New Zealand)', 'en-WL': 'English (Welsh)',
    'af-ZA': 'Afrikaans', 'ar-AE': 'Arabic (Gulf)', 'ar-SA': 'Arabic (Modern Standard)',
    'eu-ES': 'Basque', 'ca-ES': 'Catalan', 'zh-CN': 'Chinese (Simplified)',
    'zh-TW': 'Chinese (Traditional)', 'zh-HK': 'Chinese (Cantonese)',
    'hr-HR': 'Croatian', 'cs-CZ': 'Czech', 'da-DK': 'Danish', 'nl-NL': 'Dutch',
    'fa-IR': 'Farsi', 'fi-FI': 'Finnish', 'fr-FR': 'French', 'fr-CA': 'French (Canada)',
    'gl-ES': 'Galician', 'de-DE': 'German', 'de-CH': 'German (Swiss)',
    'el-GR': 'Greek', 'he-IL': 'Hebrew', 'hi-IN': 'Hindi', 'id-ID': 'Indonesian',
    'it-IT': 'Italian', 'ja-JP': 'Japanese', 'ko-KR': 'Korean',
    'lv-LV': 'Latvian', 'ms-MY': 'Malay', 'no-NO': 'Norwegian',
    'pl-PL': 'Polish', 'pt-BR': 'Portuguese (Brazil)', 'pt-PT': 'Portuguese (Portugal)',
    'ro-RO': 'Romanian', 'ru-RU': 'Russian', 'sr-RS': 'Serbian', 'sk-SK': 'Slovak',
    'so-SO': 'Somali', 'es-ES': 'Spanish (Spain)', 'es-US': 'Spanish (US)',
    'sv-SE': 'Swedish', 'tl-PH': 'Tagalog', 'th-TH': 'Thai', 'tr-TR': 'Turkish',
    'uk-UA': 'Ukrainian', 'vi-VN': 'Vietnamese', 'zu-ZA': 'Zulu',
}

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
    src_resp = table.get_item(Key={'language_code': 'SOURCE_LANGUAGE'})
    source_short = src_resp.get('Item', {}).get('source_lang_short', 'en')
    if language_code == source_short:
        return {'error': f'Cannot remove source language ({language_code}). Change the source language first.'}

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

    # Update SCREEN_MAPPING: replace removed language with a random active language
    reassigned_screens = {}
    mapping = _get_current_screen_mapping()
    affected_screens = [sid for sid, lc in mapping.items() if lc == language_code]

    if affected_screens:
        # Get all active languages (excluding the one being removed)
        scan_resp = table.scan()
        all_items = [i for i in scan_resp.get('Items', []) if _is_language_item(i)]
        active_codes = [i['language_code'] for i in all_items if i.get('active') and i['language_code'] != language_code]

        used_codes = set(lc for sid, lc in mapping.items() if sid not in affected_screens and lc != language_code)

        for sid in affected_screens:
            available = [c for c in active_codes if c not in used_codes]
            if available:
                pick = random.choice(available)
                mapping[sid] = pick
                used_codes.add(pick)
                reassigned_screens[sid] = pick
            elif active_codes:
                pick = random.choice(active_codes)
                mapping[sid] = pick
                reassigned_screens[sid] = pick

        table.put_item(Item={
            'language_code': 'SCREEN_MAPPING',
            'setting_name': 'screen_language_mapping',
            'mapping': mapping,
            'active': False
        })

    return {
        'language_code': language_code,
        'name': item['name'],
        'status': 'inactive',
        'screen_mapping': mapping,
        'reassigned_screens': reassigned_screens
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
    # DEBUG: Log received parameters with proper encoding
    print(f"[DEBUG] add_translation_mapping called:")
    print(f"  original_term: {repr(original_term)} | bytes: {original_term.encode('utf-8').hex() if original_term else 'None'}")
    print(f"  target_language: {repr(target_language)}")
    print(f"  translated_term: {repr(translated_term)} | bytes: {translated_term.encode('utf-8').hex() if translated_term else 'None'}")

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
def get_translation_mappings(language_code: str = None) -> str:
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

            # Return pre-formatted string so AI cannot hallucinate
            result = f"Here are the translation mappings for {language_code}:\n\n"
            for original, translated in mappings.items():
                result += f"- \"{original}\" → \"{translated}\"\n"
            result += f"\nTotal terms: {len(mappings)}"
            return result
        else:
            # Return all languages with pre-formatted string
            result = "Translation mappings:\n\n"
            for lang, mappings in all_mappings.items():
                result += f"{lang}:\n"
                for original, translated in mappings.items():
                    result += f"  - \"{original}\" → \"{translated}\"\n"
                result += "\n"
            return result
    except Exception as e:
        return f"Error: {str(e)}"


@tool
def remove_translation_mapping(language_code: str, original_term: str = None) -> dict:
    """Remove translation mappings. Can remove a single term or all mappings for a language.

    Args:
        language_code: ISO 639-1 language code (e.g. 'ko' for Korean)
        original_term: The original term to remove. If not provided, removes ALL mappings for the language.
    """
    language_code = language_code.lower().strip()

    try:
        resp = table.get_item(Key={'language_code': 'TRANSLATION_DICT'})
        mappings = resp.get('Item', {}).get('mappings', {})

        if language_code not in mappings or not mappings[language_code]:
            return {'error': f'No translation mappings found for {language_code}'}

        if original_term:
            original_term = original_term.strip()
            if original_term not in mappings[language_code]:
                return {'error': f'Mapping for "{original_term}" not found in {language_code}'}
            del mappings[language_code][original_term]
            # Clean up empty language dict
            if not mappings[language_code]:
                del mappings[language_code]

            table.put_item(Item={
                'language_code': 'TRANSLATION_DICT',
                'setting_name': 'term_mappings',
                'mappings': mappings,
                'active': False
            })
            return {
                'language_code': language_code,
                'removed_term': original_term,
                'status': 'removed',
                'message': f'Removed mapping: "{original_term}" from {language_code}'
            }
        else:
            removed_count = len(mappings[language_code])
            del mappings[language_code]

            table.put_item(Item={
                'language_code': 'TRANSLATION_DICT',
                'setting_name': 'term_mappings',
                'mappings': mappings,
                'active': False
            })
            return {
                'language_code': language_code,
                'removed_count': removed_count,
                'status': 'removed_all',
                'message': f'Removed all {removed_count} translation mappings for {language_code}'
            }
    except Exception as e:
        return {'error': f'Failed to remove translation mapping: {str(e)}'}


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


@tool
def set_source_language(language_code: str) -> dict:
    """Set the source language for speech-to-text transcription (Amazon Transcribe).
    Changing the source language restarts the transcription session, causing a brief 1-2 second gap.

    Args:
        language_code: Transcribe language code. Common codes:
                      'en-US' (English US), 'en-GB' (English UK), 'de-DE' (German),
                      'es-US' (Spanish US), 'es-ES' (Spanish Spain), 'it-IT' (Italian),
                      'fr-FR' (French), 'ja-JP' (Japanese), 'ko-KR' (Korean),
                      'zh-CN' (Chinese Simplified), 'zh-TW' (Chinese Traditional),
                      'pt-BR' (Portuguese Brazil), 'hi-IN' (Hindi), 'ar-SA' (Arabic),
                      'th-TH' (Thai), 'vi-VN' (Vietnamese), 'ru-RU' (Russian),
                      'pl-PL' (Polish), 'nl-NL' (Dutch), 'sv-SE' (Swedish),
                      'tr-TR' (Turkish), 'id-ID' (Indonesian), 'ms-MY' (Malay),
                      'da-DK' (Danish), 'fi-FI' (Finnish), 'no-NO' (Norwegian),
                      'cs-CZ' (Czech), 'ro-RO' (Romanian), 'el-GR' (Greek),
                      'he-IL' (Hebrew), 'fa-IR' (Farsi), 'uk-UA' (Ukrainian),
                      'hr-HR' (Croatian), 'sk-SK' (Slovak), 'sr-RS' (Serbian),
                      'lv-LV' (Latvian), 'af-ZA' (Afrikaans), 'zu-ZA' (Zulu),
                      'so-SO' (Somali), 'tl-PH' (Tagalog), 'gl-ES' (Galician),
                      'eu-ES' (Basque), 'ca-ES' (Catalan)
    """
    if language_code not in TRANSCRIBE_LANGUAGES:
        return {
            'error': f'Invalid language code. Must be one of: {", ".join(sorted(TRANSCRIBE_LANGUAGES.keys()))}',
        }

    short_code = language_code.split('-')[0]

    try:
        table.put_item(Item={
            'language_code': 'SOURCE_LANGUAGE',
            'setting_name': 'source_language',
            'value': language_code,
            'source_lang_short': short_code,
            'active': False
        })
        return {
            'language_code': language_code,
            'language_name': TRANSCRIBE_LANGUAGES[language_code],
            'short_code': short_code,
            'status': 'updated',
            'message': f'Source language set to {TRANSCRIBE_LANGUAGES[language_code]} ({language_code}). Transcription session will restart with a brief gap.'
        }
    except Exception as e:
        return {'error': f'Failed to update source language: {str(e)}'}


@tool
def get_source_language() -> dict:
    """Get the currently configured source language for speech-to-text transcription."""
    try:
        resp = table.get_item(Key={'language_code': 'SOURCE_LANGUAGE'})
        item = resp.get('Item', {})
        lang_code = item.get('value', 'en-US')
        return {
            'language_code': lang_code,
            'language_name': TRANSCRIBE_LANGUAGES.get(lang_code, lang_code),
            'status': 'active'
        }
    except Exception as e:
        return {'language_code': 'en-US', 'error': str(e)}
