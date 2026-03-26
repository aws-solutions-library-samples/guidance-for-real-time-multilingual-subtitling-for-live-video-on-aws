import json
import os
import re
from strands import Agent
from strands.models import BedrockModel
from tools import list_languages, add_language, remove_language, get_system_status

model = BedrockModel(
    model_id="us.amazon.nova-lite-v1:0",
    region_name=os.environ.get('AWS_REGION', 'us-east-1')
)

SYSTEM_PROMPT = """You are a live subtitle management assistant for a real-time multilingual subtitling system.

Your capabilities:
- List currently active and available subtitle languages
- Add new subtitle languages (activate translation)
- Remove subtitle languages (deactivate translation)
- Check system status (slots, capacity)

Rules:
- The system supports up to 20 simultaneous subtitle languages
- English (en) is the source language and cannot be removed
- When a user mentions a language, map it to the correct ISO 639-1 code
- Always confirm the action result to the user
- Respond in the same language the user is speaking
- Be concise - this is a chat widget, not a document
- Do NOT use <thinking> tags or any internal reasoning in your responses

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

TOOLS = [list_languages, add_language, remove_language, get_system_status]

# Session history storage (in-memory, per Lambda instance)
sessions = {}


def handler(event, context):
    body = json.loads(event.get('body', '{}'))
    user_message = body.get('message', '')
    session_id = body.get('session_id', 'default')

    if not user_message:
        return _response(400, {'error': 'message is required'})

    messages = sessions.get(session_id, [])

    agent = Agent(
        model=model,
        tools=TOOLS,
        system_prompt=SYSTEM_PROMPT,
        messages=messages,
        callback_handler=None
    )

    try:
        result = agent(user_message)

        # Save conversation history
        sessions[session_id] = agent.messages
        # Memory management: keep max 100 sessions
        if len(sessions) > 100:
            oldest = next(iter(sessions))
            del sessions[oldest]

        response_text = re.sub(r'<thinking>.*?</thinking>\s*', '', str(result), flags=re.DOTALL).strip()

        return _response(200, {
            'response': response_text,
            'session_id': session_id
        })
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
