import json
import os
import re
import unicodedata
from strands import Agent
from strands.models import BedrockModel
from tools import (
    list_languages, add_language, remove_language, get_system_status,
    set_translation_style, add_translation_mapping, get_translation_mappings,
    set_screen_language, get_screen_mapping, _get_current_screen_mapping,
    set_translation_model, get_translation_model,
    set_source_language, get_source_language
)
import tools as tools_module


def _detect_language(text):
    """Detect language from Unicode script of the text."""
    script_counts = {}
    for ch in text:
        if ch.isspace() or ch.isdigit() or ch in '.,!?@#$%^&*()_+-=[]{}|;:\'\"<>/':
            continue
        try:
            name = unicodedata.name(ch, '')
        except ValueError:
            continue
        if 'HANGUL' in name:
            script_counts['ko'] = script_counts.get('ko', 0) + 1
        elif 'CJK' in name:
            script_counts['zh'] = script_counts.get('zh', 0) + 1
        elif 'HIRAGANA' in name or 'KATAKANA' in name:
            script_counts['ja'] = script_counts.get('ja', 0) + 1
        elif 'ARABIC' in name:
            script_counts['ar'] = script_counts.get('ar', 0) + 1
        elif 'THAI' in name:
            script_counts['th'] = script_counts.get('th', 0) + 1
        elif 'DEVANAGARI' in name:
            script_counts['hi'] = script_counts.get('hi', 0) + 1
        elif 'CYRILLIC' in name:
            script_counts['ru'] = script_counts.get('ru', 0) + 1
        elif 'LATIN' in name:
            script_counts['latin'] = script_counts.get('latin', 0) + 1

    if not script_counts:
        return 'en'

    dominant = max(script_counts, key=script_counts.get)
    return dominant if dominant != 'latin' else 'en'


LANGUAGE_NAMES = {
    'ko': 'Korean (한국어)',
    'ja': 'Japanese (日本語)',
    'zh': 'Chinese (中文)',
    'ar': 'Arabic (العربية)',
    'th': 'Thai (ภาษาไทย)',
    'hi': 'Hindi (हिन्दी)',
    'ru': 'Russian (Русский)',
    'en': 'English',
}

model = BedrockModel(
    model_id="us.amazon.nova-pro-v1:0",
    region_name=os.environ.get('AWS_REGION', 'us-east-1')
)

SYSTEM_PROMPT = """You are a live subtitle management assistant for a real-time multilingual subtitling system.

Your capabilities:

**Language Management:**
- List currently active and available subtitle languages
- Add new subtitle languages (activate translation)
- Remove subtitle languages (deactivate translation)
- Check system status (slots, capacity)

**Translation Quality:**
- Set translation style (formal, casual, technical, energetic)
- Add translation mappings to control how specific terms are translated
- View current translation mappings for each language

**Screen Management:**
- Assign a specific language to a specific screen (1-4)
- View current screen-to-language mapping
- Example: "Show Korean on screen 1" → set_screen_language('1', 'ko')

Rules:
- The system supports up to 20 simultaneous subtitle languages
- The current source language cannot be removed from active languages (use get_source_language to check)
- The source language CAN be changed using set_source_language (e.g., from English to Korean)
- When a user mentions a language, map it to the correct ISO 639-1 code
- When a user says "screen 1", "screen1", "스크린1", or similar, extract the screen number (1-4)
- **Screen assignment flow:**
  1. If the language is not active, call add_language first
  2. Then call set_screen_language to assign the screen
  3. If set_screen_language returns status 'assigned' → confirm: "스크린 전환 완료!"
  4. If set_screen_language returns status 'pending' → tell the user: "자막 데이터 준비 중입니다. 데이터가 확인되면 자동으로 스크린에 반영됩니다!" (The frontend will poll and send a [SYSTEM] message when data is ready)
- **[SYSTEM] messages**: When you receive a message starting with [SYSTEM], it is an automated notification from the frontend. For example "[SYSTEM] Korean subtitle data ready for screen 3" means subtitle data is now available. When you receive this, call set_screen_language with the specified screen and language to complete the switch, and confirm to the user.
- After ADDING a language with add_language (without screen assignment), always suggest screen assignment. Example: "한국어 자막이 활성화되었습니다! 어떤 스크린(1~4)에 표시할까요?"
- After REMOVING a language (remove_language), do NOT suggest screen assignment. Just confirm the removal.
- Always confirm the action result to the user
- When the user says "remove X" or "delete X" or "X 제거" or "X 삭제", map X to the correct language code and call remove_language. Common mappings: Korean→ko, German→de, Spanish→es, Italian→it, Japanese→ja, French→fr, Chinese→zh, Arabic→ar, Thai→th, Hindi→hi, Portuguese→pt, Russian→ru, Vietnamese→vi, Polish→pl, Dutch→nl, Swedish→sv, Turkish→tr, Indonesian→id, Malay→ms
- **CRITICAL**: When the user message starts with [INSTRUCTION: Reply ENTIRELY in ...], you MUST follow that instruction and respond ONLY in that language. Never mix English. This applies to ALL parts of your response including confirmations, errors, lists, and suggestions.
- Be concise - this is a chat widget, not a document
- Do NOT use <thinking> tags or any internal reasoning in your responses

Translation Styles:
- **formal**: Professional, broadcast-standard language
- **casual**: Relaxed, conversational tone
- **technical**: Precise, technical terminology
- **energetic**: Exciting sports commentary style (default)

Translation Models:
- **nova-lite**: Fast and efficient (default)
- **nova-micro**: Ultra-low latency, fastest
- **nova-pro**: Balanced quality and speed
- **claude-haiku**: Highest translation quality
- When user says "change model to X" or "use nova pro", call set_translation_model with full model ID

**Source Language (Input Audio Language — NOT subtitle language):**
- This controls the language of the LIVE AUDIO/VIDEO being broadcast (speech-to-text input)
- This is completely separate from subtitle languages — subtitles are translations OUTPUT
- Example: If broadcasting Korean TV, set source to ko-KR. Subtitles will then translate FROM Korean TO other languages.
- Default source is English (en-US). Use set_source_language/get_source_language to change/check it.
- Changing source language restarts the transcription session (1-2 second gap)
- When user says "change source to X", "입력 언어를 X로", "change input language" → call set_source_language
- Common mappings: English→en-US, Korean→ko-KR, Japanese→ja-JP, Chinese→zh-CN, German→de-DE, Spanish→es-US, French→fr-FR, Italian→it-IT, Portuguese→pt-BR, Hindi→hi-IN, Arabic→ar-SA, Thai→th-TH

Response formatting:
- When listing languages, ALWAYS use a numbered list with flag emoji and status indicator
- Format each language as: "NUMBER. FLAG LANGUAGE_NAME (CODE) STATUS"
- Use ✅ for active languages and ⬚ for inactive languages
- Example format:
  1. 🇺🇸 English (en) ✅
  2. 🇩🇪 German (de) ✅
  3. 🇪🇸 Spanish (es) ⬚
- Show active languages first, then inactive languages separated by a blank line
- At the end show a summary like: "Active: 4/20 slots used"

Language codes and their flag emoji:
en=🇺🇸English, de=🇩🇪German, es=🇪🇸Spanish, it=🇮🇹Italian, ko=🇰🇷Korean, hi=🇮🇳Hindi,
ja=🇯🇵Japanese, fr=🇫🇷French, pt=🇧🇷Portuguese, zh=🇨🇳Chinese, ar=🇸🇦Arabic, th=🇹🇭Thai,
vi=🇻🇳Vietnamese, ru=🇷🇺Russian, pl=🇵🇱Polish, nl=🇳🇱Dutch, sv=🇸🇪Swedish, tr=🇹🇷Turkish,
id=🇮🇩Indonesian, ms=🇲🇾Malay"""

TOOLS = [
    list_languages, add_language, remove_language, get_system_status,
    set_translation_style, add_translation_mapping, get_translation_mappings,
    set_screen_language, get_screen_mapping,
    set_translation_model, get_translation_model,
    set_source_language, get_source_language
]

# Session history storage (in-memory, per Lambda instance)
sessions = {}


def handler(event, context):
    body = json.loads(event.get('body', '{}'))
    user_message = body.get('message', '')
    session_id = body.get('session_id', 'default')

    if not user_message:
        return _response(400, {'error': 'message is required'})

    messages = sessions.get(session_id, [])

    # Guard against corrupted session history
    if messages and (not messages[0].get('role') or messages[0]['role'] != 'user'):
        messages = []
        sessions[session_id] = messages

    agent = Agent(
        model=model,
        tools=TOOLS,
        system_prompt=SYSTEM_PROMPT,
        messages=messages,
        callback_handler=None
    )

    try:
        # Handle [SYSTEM] messages directly — no LLM needed, just update screen mapping
        if user_message.startswith('[SYSTEM]'):
            system_match = re.match(r'\[SYSTEM\]\s+(\w+)\s+subtitle data ready for screen\s+(\d+)', user_message)
            if system_match:
                lang_code = system_match.group(1)
                screen_id = system_match.group(2)

                # Directly update SCREEN_MAPPING and clear pending flag
                mapping = _get_current_screen_mapping()
                mapping[screen_id] = lang_code
                tbl = tools_module.table
                tbl.put_item(Item={
                    'language_code': 'SCREEN_MAPPING',
                    'setting_name': 'screen_language_mapping',
                    'mapping': mapping,
                    'active': False
                })
                # Clear the pending flag so check-subtitle stops returning true
                tbl.update_item(
                    Key={'language_code': lang_code},
                    UpdateExpression='SET needs_pending_screen = :flag',
                    ExpressionAttributeValues={':flag': False}
                )

                # Detect language for response
                last_lang = 'en'
                for prev_msg in reversed(messages):
                    if prev_msg.get('role') == 'user':
                        prev_text = ''
                        for block in prev_msg.get('content', []):
                            if isinstance(block, dict) and 'text' in block:
                                prev_text = block['text']
                                break
                            elif isinstance(block, str):
                                prev_text = block
                                break
                        if prev_text and not prev_text.startswith('[SYSTEM]'):
                            last_lang = _detect_language(prev_text)
                            break

                # Get language name for display
                resp = tbl.get_item(Key={'language_code': lang_code})
                lang_name_display = resp.get('Item', {}).get('name', lang_code)

                confirm_messages = {
                    'ko': f'스크린 {screen_id}에 {lang_name_display} 자막이 반영되었습니다! ✅',
                    'ja': f'スクリーン{screen_id}に{lang_name_display}字幕が反映されました！ ✅',
                    'zh': f'屏幕{screen_id}已切换为{lang_name_display}字幕！ ✅',
                    'en': f'Screen {screen_id} is now showing {lang_name_display} subtitles! ✅',
                }
                response_text = confirm_messages.get(last_lang, confirm_messages['en'])

                return _response(200, {
                    'response': response_text,
                    'session_id': session_id,
                    'screen_mapping': mapping
                })

        # Normal user messages — route through LLM agent
        detected_lang = _detect_language(user_message)
        lang_name = LANGUAGE_NAMES.get(detected_lang, detected_lang)
        augmented_message = f"[INSTRUCTION: Reply ENTIRELY in {lang_name}. Do NOT use any other language.]\n\n{user_message}"

        result = agent(augmented_message)

        # Save conversation history
        sessions[session_id] = agent.messages
        # Memory management: keep max 100 sessions
        if len(sessions) > 100:
            oldest = next(iter(sessions))
            del sessions[oldest]

        response_text = re.sub(r'<thinking>.*?</thinking>\s*', '', str(result), flags=re.DOTALL).strip()

        response_body = {
            'response': response_text,
            'session_id': session_id
        }

        # Check if set_screen_language flagged a pending screen switch
        if tools_module._pending_screen is not None:
            response_body['pending_screen'] = tools_module._pending_screen
            tools_module._pending_screen = None
            # Do NOT include screen_mapping when pending — frontend should
            # only switch screens after [SYSTEM] confirms data is ready
        else:
            # Include screen mapping so frontend can sync displays
            try:
                screen_mapping = _get_current_screen_mapping()
                response_body['screen_mapping'] = screen_mapping
            except Exception:
                pass

        return _response(200, response_body)
    except Exception as e:
        print(f"Agent error: {e}")
        return _response(500, {
            'error': 'Failed to process message',
            'session_id': session_id
        })


def _response(status_code, body):
    return {
        'statusCode': status_code,
        'headers': {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type,Authorization',
            'Access-Control-Allow-Methods': 'POST,OPTIONS'
        },
        'body': json.dumps(body)
    }
