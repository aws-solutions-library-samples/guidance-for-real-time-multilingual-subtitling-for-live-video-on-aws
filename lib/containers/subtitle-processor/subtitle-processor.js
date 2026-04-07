const { spawn } = require('child_process');
const { PassThrough } = require('stream');
const { TranscribeStreamingClient, StartStreamTranscriptionCommand } = require('@aws-sdk/client-transcribe-streaming');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const AWS = require('aws-sdk');

// Configuration
const REGION = process.env.AWS_REGION || 'us-east-1';
let SOURCE_LANGUAGE = process.env.SOURCE_LANGUAGE || 'en';
const LANGUAGE_CONFIG_TABLE = process.env.LANGUAGE_CONFIG_TABLE || 'LanguageConfigTable';
const DYNAMODB_TABLE = process.env.DYNAMODB_TABLE || 'SubtitleTable';
let languageCode = process.env.LANGUAGE_CODE || 'en-US';
const CustomVocabulary = process.env.VOCABULARY_NAME || 'custom-vocabulary';
const MediaSampleRateHertz = 16000;

// Container-specific: RTP bind address (0.0.0.0 for Fargate, 127.0.0.1 for EC2)
const RTP_BIND_ADDRESS = process.env.RTP_BIND_ADDRESS || '0.0.0.0';
const RTP_PORT = process.env.RTP_PORT || '5000';

// AWS clients
const dynamodb = new AWS.DynamoDB.DocumentClient({ region: REGION });
const dynamodbClient = new AWS.DynamoDB({ region: REGION });
const bedrockClient = new BedrockRuntimeClient({ region: REGION });

let wordBuffer = [];
let accumulatedItems = [];
let currentFFmpegProcess = null;
let restartScheduled = false;
let translationStyle = 'energetic'; // Default style
let translationMappings = {}; // Format: { "ko": { "Messi": "리오넬 메시" }, "ja": { ... } }
let vocabularyTerms = []; // Custom terms from VOCABULARY key
let translationModelId = 'us.amazon.nova-micro-v1:0'; // Default model

// Load translation style from DynamoDB
async function loadTranslationStyle() {
    try {
        const result = await dynamodb.get({
            TableName: LANGUAGE_CONFIG_TABLE,
            Key: { language_code: 'SETTINGS' }
        }).promise();

        if (result.Item && result.Item.value) {
            translationStyle = result.Item.value;
            console.log(`Translation style loaded: ${translationStyle}`);
        }
    } catch (error) {
        console.log('Using default translation style (energetic):', error.message);
    }
}

// Load translation mappings from DynamoDB
async function loadTranslationMappings() {
    try {
        const result = await dynamodb.get({
            TableName: LANGUAGE_CONFIG_TABLE,
            Key: { language_code: 'TRANSLATION_DICT' }
        }).promise();

        if (result.Item && result.Item.mappings) {
            translationMappings = result.Item.mappings;
            const totalTerms = Object.keys(translationMappings).reduce((sum, lang) =>
                sum + Object.keys(translationMappings[lang]).length, 0);
            console.log(`Translation mappings loaded: ${totalTerms} terms across ${Object.keys(translationMappings).length} languages`);
        }
    } catch (error) {
        console.log('No translation mappings found:', error.message);
    }
}

// Load vocabulary terms from DynamoDB
async function loadVocabularyTerms() {
    try {
        const result = await dynamodb.get({
            TableName: LANGUAGE_CONFIG_TABLE,
            Key: { language_code: 'VOCABULARY' }
        }).promise();

        if (result.Item && result.Item.terms) {
            vocabularyTerms = result.Item.terms;
            console.log(`Vocabulary terms loaded: ${vocabularyTerms.length} terms`);
        }
    } catch (error) {
        console.log('No vocabulary terms found:', error.message);
    }
}

// Load translation model from DynamoDB
async function loadTranslationModel() {
    try {
        const result = await dynamodb.get({
            TableName: LANGUAGE_CONFIG_TABLE,
            Key: { language_code: 'MODEL_SETTINGS' }
        }).promise();

        if (result.Item && result.Item.value) {
            translationModelId = result.Item.value;
            console.log(`Translation model loaded: ${translationModelId}`);
        }
    } catch (error) {
        console.log('Using default translation model:', error.message);
    }
}

// Load source language from DynamoDB
async function loadSourceLanguage() {
    try {
        const result = await dynamodb.get({
            TableName: LANGUAGE_CONFIG_TABLE,
            Key: { language_code: 'SOURCE_LANGUAGE' }
        }).promise();

        if (result.Item && result.Item.value) {
            const newLanguageCode = result.Item.value;
            const newShortCode = result.Item.source_lang_short || newLanguageCode.split('-')[0];

            if (newLanguageCode !== languageCode) {
                console.log(`Source language change detected: ${languageCode} → ${newLanguageCode}`);
                languageCode = newLanguageCode;
                SOURCE_LANGUAGE = newShortCode;
                return true;
            }
        }
    } catch (error) {
        console.log('Using default source language:', error.message);
    }
    return false;
}

// Build Bedrock request body based on model type
function buildModelRequest(modelId, systemPrompt, userText) {
    if (modelId.includes('anthropic') || modelId.includes('claude')) {
        // Anthropic Claude format — system prompt separated for better instruction following
        return {
            body: JSON.stringify({
                anthropic_version: "bedrock-2023-05-31",
                system: systemPrompt,
                messages: [{ role: "user", content: [{ type: "text", text: userText }] }],
                max_tokens: 2000,
                temperature: 0.1
            })
        };
    } else {
        // Amazon Nova / default format — system + user combined in messages
        return {
            body: JSON.stringify({
                system: [{ text: systemPrompt }],
                messages: [{ role: "user", content: [{ text: userText }] }],
                inferenceConfig: {
                    maxTokens: 2000,
                    temperature: 0.1,
                    top_p: 0.9,
                    stopSequences: []
                }
            })
        };
    }
}

// Parse Bedrock response based on model type
function parseModelResponse(modelId, responseBody) {
    if (modelId.includes('anthropic') || modelId.includes('claude')) {
        return responseBody.content[0].text.trim();
    } else {
        return responseBody.output.message.content[0].text.trim();
    }
}

// Kill existing FFmpeg processes
function killExistingFFmpeg() {
    if (currentFFmpegProcess) {
        try {
            currentFFmpegProcess.kill('SIGKILL');
        } catch (e) {}
        currentFFmpegProcess = null;
    }
}

// FFmpeg — Container-optimized for Fargate (no -re, increased buffers, 0.0.0.0 bind)
async function runFFMPEG() {
    console.log(`Starting FFmpeg on rtp://${RTP_BIND_ADDRESS}:${RTP_PORT}...`);
    killExistingFFmpeg();

    const ls = spawn("ffmpeg", [
        "-fflags", "+discardcorrupt+genpts",
        "-analyzeduration", "10000000",
        "-probesize", "10000000",
        "-thread_queue_size", "8192",
        "-reorder_queue_size", "100000",
        "-buffer_size", "32768k",
        "-max_delay", "5000000",
        // NOTE: -re intentionally removed for Fargate (208KB kernel buffer would overflow)
        "-i", `rtp://${RTP_BIND_ADDRESS}:${RTP_PORT}`,
        "-vn",
        "-map", "0:a",
        "-acodec", "pcm_s16le",
        "-f", "wav",
        "-ac", "1",
        "-ar", "16000",
        "-"
    ]);

    currentFFmpegProcess = ls;

    ls.stderr.on("data", data => {
        const errorMsg = data.toString();
        if (!errorMsg.includes('PES packet size mismatch') && !errorMsg.includes('Packet corrupt') &&
            !errorMsg.includes('size=') && !errorMsg.includes('time=') &&
            !errorMsg.includes('bitrate=') && !errorMsg.includes('speed=') &&
            !errorMsg.includes('attempted to set receive buffer') && !errorMsg.includes('libav') &&
            !errorMsg.includes('ffmpeg version') && !errorMsg.includes('built with') &&
            !errorMsg.includes('configuration:') && !errorMsg.includes('lib') &&
            !errorMsg.includes('Input #0') && !errorMsg.includes('Stream #0') &&
            !errorMsg.includes('Duration:') && !errorMsg.includes('Stream mapping:') &&
            !errorMsg.includes('Press [q]') && !errorMsg.includes('Codec AVOption') &&
            !errorMsg.includes('service_name') && !errorMsg.includes('Metadata:')) {
            console.log(`stderr: ${errorMsg}`);
        }
    });

    ls.on('error', (err) => {
        console.error(`FFmpeg spawn error: ${err.message} (code: ${err.code})`);
        scheduleRestart();
    });

    ls.on("close", (code, signal) => {
        if (code !== 0 || signal) {
            console.log(`FFmpeg closed with code=${code}, signal=${signal}`);
            scheduleRestart();
        }
    });

    return ls;
}

// Stream audio to transcribe
async function streamAudioToWebSocket(audioStream) {
    let lastResultId = null;
    let currentResultTime = null;
    let sessionStartTime = Date.now();

    try {
        // Container-optimized: 4MB PassThrough buffer (4x EC2 value)
        const audioPayloadStream = new PassThrough({ highWaterMark: 1024 * 4096 });
        audioStream.stdout.pipe(audioPayloadStream);

        // Transcribe Streaming limit: max ~32KB per AudioEvent
        const MAX_CHUNK_SIZE = 25 * 1024; // 25KB safe limit
        const transcribeInput = async function* () {
            for await(const chunk of audioPayloadStream) {
                for (let offset = 0; offset < chunk.length; offset += MAX_CHUNK_SIZE) {
                    yield { AudioEvent: { AudioChunk: chunk.slice(offset, offset + MAX_CHUNK_SIZE) } };
                }
            }
        };

        const client = new TranscribeStreamingClient({ region: REGION });
        const transcribeParams = {
            LanguageCode: languageCode,
            MediaSampleRateHertz: MediaSampleRateHertz,
            MediaEncoding: 'pcm',
            AudioStream: transcribeInput()
        };
        if (languageCode.startsWith('en')) {
            transcribeParams.VocabularyName = CustomVocabulary;
        }
        const res = await client.send(new StartStreamTranscriptionCommand(transcribeParams));

        for await(const event of res.TranscriptResultStream) {
            if (event.TranscriptEvent?.Transcript?.Results?.length > 0) {
                const result = event.TranscriptEvent.Transcript.Results[0];
                const IsPartial = result.IsPartial;

                if (result.Alternatives?.length > 0) {
                    // Check if ResultId changed or first time
                    if (lastResultId !== result.ResultId) {
                        currentResultTime = Date.now();
                        lastResultId = result.ResultId;
                    }

                    // Add currentResultTime to result
                    result.currentResultTime = currentResultTime;
                    result.sessionStartTime = sessionStartTime;

                    console.log(result.Alternatives[0].Transcript);

                    if (!IsPartial) {
                        console.log(result.Alternatives[0].Transcript);
                        processTranscript(result).catch(err => console.error('Process error:', err));
                    }
                }
            }
        }
    } catch (error) {
        console.error('Transcription error:', error);
        scheduleRestart();
    }
}

// Process transcript and accumulate items
async function processTranscript(result) {
    const { ResultId, IsPartial, Alternatives, EndTime, StartTime, sessionStartTime } = result;
    const items = Alternatives[0].Items;
    const transcript = Alternatives[0].Transcript;
    const currentTime = sessionStartTime;

    // Replace accumulated items with latest items (not concatenate)
    accumulatedItems = items;

    // Extract and store completed 5-second segments
    const completedSegments = extractCompletedSegments();
    if (completedSegments.length > 0) {
        console.log(`==Storing ${completedSegments.length} completed 5-second segments==`);
        await storeCompletedSegments(completedSegments, ResultId, currentTime, IsPartial);
    }

    // Track words for translation trigger
    wordBuffer = wordBuffer.concat(items.filter(item => item.Type === 'pronunciation'));

    // Translate if conditions met
    if (!IsPartial || transcript.length >= 750) {
        // Get all segments (completed + remaining) for translation
        const allSegments = completedSegments.concat(getRemainingSegments());
        if (allSegments.length > 0) {
            await translateAndStore(transcript, ResultId, allSegments, currentTime, IsPartial);
        }
        wordBuffer = [];
    }

    // Store remaining segments if final result
    if (!IsPartial && accumulatedItems.length > 0) {
        const remainingSegments = getRemainingSegments();
        if (remainingSegments.length > 0) {
            console.log("==Storing final remaining segments==");
            await storeCompletedSegments(remainingSegments, ResultId, currentTime, IsPartial);
            accumulatedItems = [];
        }
    }
}

// Extract completed 5-second segments from accumulated items
function extractCompletedSegments() {
    const completedSegments = [];
    let currentSegment = [];
    let segmentStartTime = null;

    for (let i = 0; i < accumulatedItems.length; i++) {
        const item = accumulatedItems[i];

        if (segmentStartTime === null) {
            segmentStartTime = item.StartTime;
        }

        // Check if adding this item would exceed 5 seconds
        if (item.EndTime - segmentStartTime > 5) {
            // Complete current segment if it has items
            if (currentSegment.length > 0) {
                completedSegments.push(currentSegment);
                currentSegment = [item];
                segmentStartTime = item.StartTime;
            } else {
                // Single item exceeds 5 seconds, add it anyway
                currentSegment.push(item);
                completedSegments.push(currentSegment);
                currentSegment = [];
                segmentStartTime = null;
            }
        } else {
            currentSegment.push(item);

            // If next item is punctuation, include it
            if (i + 1 < accumulatedItems.length && accumulatedItems[i + 1].Type === 'punctuation') {
                currentSegment.push(accumulatedItems[i + 1]);
                i++; // Skip the punctuation item in next iteration
            }
        }
    }

    // Keep incomplete segment in accumulated items
    accumulatedItems = currentSegment;

    return completedSegments;
}

// Get remaining segments (for translation context)
function getRemainingSegments() {
    if (accumulatedItems.length === 0) return [];
    return [accumulatedItems]; // Return as single segment
}

// Store completed segments
async function storeCompletedSegments(segments, resultId, currentTime, isPartial) {
    const records = segments.map((segment, segmentIndex) => {
        const startTime = segment[0].StartTime;
        const endTime = segment[segment.length - 1].EndTime;
        const content = segment.map((item, index) => {
            const nextItem = segment[index + 1];
            return item.Content + (nextItem && nextItem.Type === 'punctuation' ? '' : ' ');
        }).join('').trim();
        const itemCreatedTime = currentTime + (startTime * 1000);
        const date = new Date(itemCreatedTime);
        const create_htime = `${date.getUTCHours().toString().padStart(2, '0')}:${date.getUTCMinutes().toString().padStart(2, '0')}:${date.getUTCSeconds().toString().padStart(2, '0')}:${date.getUTCMilliseconds().toString().padStart(3, '0')}`;
        const date1 = Date.now();
        const date2 = new Date(date1);
        const create_Acttime = `${date2.getUTCHours().toString().padStart(2, '0')}:${date2.getUTCMinutes().toString().padStart(2, '0')}:${date2.getUTCSeconds().toString().padStart(2, '0')}:${date2.getUTCMilliseconds().toString().padStart(3, '0')}`;

        return {
            id_name: `${startTime}-${resultId}-${segmentIndex}`,
            id_lang: SOURCE_LANGUAGE,
            created_time: itemCreatedTime,
            create_htime: create_htime,
            create_Acttime: create_Acttime,
            content: content,
            start_time: startTime,
            end_time: endTime,
            timestamp_ttl: Math.floor((itemCreatedTime + 7200000) / 1000),
            IsPartial: isPartial
        };
    });

    await storeItems(records);
}

// Store items in DynamoDB
async function storeItems(items) {
    try {
        // Log content of each item being stored
        items.forEach(item => {
            console.log(`==Storing content==> ${item.content} | create_htime: ${item.create_htime}`);
        });

        for (let i = 0; i < items.length; i += 25) {
            const batch = items.slice(i, i + 25).map(item => ({ PutRequest: { Item: item } }));
            await dynamodb.batchWrite({ RequestItems: { [DYNAMODB_TABLE]: batch } }).promise();
        }
    } catch (error) {
        if (error.code === 'ResourceNotFoundException') {
            console.log('Table not found, creating...');
            await createTable();
            await storeItems(items); // Retry after creating table
        } else {
            throw error;
        }
    }
}

// Get active languages from DynamoDB (called on each translation, no cache)
async function getActiveLanguages() {
    try {
        const result = await dynamodb.scan({
            TableName: LANGUAGE_CONFIG_TABLE,
            FilterExpression: 'active = :active',
            ExpressionAttributeValues: { ':active': true }
        }).promise();
        return (result.Items || []).map(item => item.language_code);
    } catch (error) {
        console.error('Error fetching active languages, using fallback:', error);
        return ['en', 'de', 'es', 'it'];
    }
}

// Translate a single language (extracted for parallel execution)
async function translateSingleLanguage(transcript, resultId, originalChunks, currentTime, isPartial, targetLang) {
    // Define style-specific prompts
    const stylePrompts = {
        formal: 'Translate in a professional, broadcast-standard style with formal language and proper terminology.',
        casual: 'Translate in a relaxed, conversational tone with natural, everyday language.',
        technical: 'Translate with precise, technical terminology and accuracy. Use formal technical vocabulary.',
        energetic: 'Translate in an exciting, dynamic sports commentary style with energetic language and expressions appropriate for live sports broadcasting.'
    };

    const styleInstruction = stylePrompts[translationStyle] || stylePrompts['energetic'];

    const vocabInstruction = vocabularyTerms.length > 0
        ? `\nIMPORTANT: Use these specific terms/translations when they appear: ${vocabularyTerms.join(', ')}. Keep these terms as provided or translate them naturally using the given form.`
        : '';

    const systemPrompt = `You are an expert translator for live broadcast subtitles.

TASK: Translate the following subtitle text from ${SOURCE_LANGUAGE} to ${targetLang}.

STYLE: ${styleInstruction}${vocabInstruction}

CRITICAL RULES:
- Output ONLY the translated text
- DO NOT add explanations, notes, comments, or meta-information
- DO NOT use markdown, XML tags, or any formatting
- DO NOT add phrases like "Here is the translation:" or "Translation:"
- DO NOT add your own interpretations or editorial comments
- If the input is just dialogue, output only the translated dialogue

EXAMPLE:
Input: "The goalkeeper makes an incredible save!"
Output: [translated text only, nothing else]

Your response must be pure translated text with no additional content.`;

    const modelRequest = buildModelRequest(translationModelId, systemPrompt, transcript);
    const command = new InvokeModelCommand({
        modelId: translationModelId,
        contentType: "application/json",
        body: modelRequest.body
    });

    const response = await bedrockClient.send(command);
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    let fullTranslatedText = parseModelResponse(translationModelId, responseBody);

    // Apply translation mappings (term substitution)
    if (translationMappings[targetLang]) {
        const mappings = translationMappings[targetLang];
        for (const [originalTerm, translatedTerm] of Object.entries(mappings)) {
            // Case-insensitive replacement
            const regex = new RegExp(originalTerm, 'gi');
            const beforeReplace = fullTranslatedText;
            fullTranslatedText = fullTranslatedText.replace(regex, translatedTerm);
            if (beforeReplace !== fullTranslatedText) {
                console.log(`==Applied mapping [${targetLang}]: "${originalTerm}" → "${translatedTerm}"==`);
            }
        }
    }

    console.log(`==Translated [${targetLang}]==> `, fullTranslatedText);

    // Segment translated text based on original chunk count
    const totalSegments = originalChunks.length;
    const translatedWords = fullTranslatedText.split(/\s+/);
    const totalWords = translatedWords.length;
    const wordsPerSegment = Math.ceil(totalWords / totalSegments);

    const translatedRecords = [];
    let wordIndex = 0;

    for (let chunkIndex = 0; chunkIndex < originalChunks.length; chunkIndex++) {
        const chunk = originalChunks[chunkIndex];
        const isLastSegment = chunkIndex === originalChunks.length - 1;
        const segmentWordCount = isLastSegment ? totalWords - wordIndex : wordsPerSegment;
        const segmentWords = translatedWords.slice(wordIndex, wordIndex + segmentWordCount);
        wordIndex += segmentWordCount;

        if (segmentWords.length === 0) continue;

        const startTime = chunk[0].StartTime;
        const endTime = chunk[chunk.length - 1].EndTime;
        const itemCreatedTime = currentTime + (startTime * 1000);
        const date = new Date(itemCreatedTime);
        const create_htime = `${date.getUTCHours().toString().padStart(2, '0')}:${date.getUTCMinutes().toString().padStart(2, '0')}:${date.getUTCSeconds().toString().padStart(2, '0')}:${date.getUTCMilliseconds().toString().padStart(3, '0')}`;
        const date1 = Date.now();
        const date2 = new Date(date1);
        const create_Acttime = `${date2.getUTCHours().toString().padStart(2, '0')}:${date2.getUTCMinutes().toString().padStart(2, '0')}:${date2.getUTCSeconds().toString().padStart(2, '0')}:${date2.getUTCMilliseconds().toString().padStart(3, '0')}`;

        translatedRecords.push({
            id_name: `${startTime}-${resultId}-${targetLang}-${chunkIndex}`,
            id_lang: targetLang,
            created_time: itemCreatedTime,
            create_htime: create_htime,
            create_Acttime: create_Acttime,
            content: segmentWords.join(' '),
            start_time: startTime,
            end_time: endTime,
            timestamp_ttl: Math.floor((itemCreatedTime + 7200000) / 1000),
            IsPartial: isPartial
        });
    }

    await storeItems(translatedRecords);
}

// Translate and store with parallel batch execution
async function translateAndStore(transcript, resultId, originalChunks, currentTime, isPartial) {
    await loadTranslationStyle();
    await loadTranslationMappings();
    await loadVocabularyTerms();
    await loadTranslationModel();

    const languageChanged = await loadSourceLanguage();
    if (languageChanged) {
        console.log('Source language changed, scheduling Transcribe restart...');
        scheduleRestart();
        return;
    }

    const activeLanguages = await getActiveLanguages();
    const targetLanguages = activeLanguages.filter(lang => lang !== SOURCE_LANGUAGE);

    console.log(`==Active languages: [${activeLanguages.join(',')}], translating to: [${targetLanguages.join(',')}]==`);

    // Parallel translation in batches of 5
    const BATCH_SIZE = 5;
    for (let i = 0; i < targetLanguages.length; i += BATCH_SIZE) {
        const batch = targetLanguages.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(targetLang =>
            translateSingleLanguage(transcript, resultId, originalChunks, currentTime, isPartial, targetLang)
                .catch(error => console.error(`Translation error for ${targetLang}:`, error))
        ));
    }
}

// Create DynamoDB table if it doesn't exist
async function createTable() {
    const params = {
        TableName: DYNAMODB_TABLE,
        KeySchema: [
            { AttributeName: 'id_name', KeyType: 'HASH' },
            { AttributeName: 'id_lang', KeyType: 'RANGE' }
        ],
        AttributeDefinitions: [
            { AttributeName: 'id_name', AttributeType: 'S' },
            { AttributeName: 'id_lang', AttributeType: 'S' }
        ],
        BillingMode: 'PAY_PER_REQUEST'
    };

    await dynamodbClient.createTable(params).promise();
    await dynamodbClient.waitFor('tableExists', { TableName: DYNAMODB_TABLE }).promise();
    console.log('Table created successfully');
}

// Guard against duplicate restart timers (Transcribe error + FFmpeg close both fire)
function scheduleRestart() {
    if (restartScheduled) return;
    restartScheduled = true;
    console.log('Scheduling restart in 10 seconds...');
    setTimeout(startService, 10000);
}

// Start service function
async function startService() {
    restartScheduled = false;
    // Load all dynamic settings from DynamoDB at startup
    await loadTranslationStyle();
    await loadTranslationMappings();
    await loadVocabularyTerms();
    await loadTranslationModel();
    await loadSourceLanguage();

    const audioStream = await runFFMPEG();
    if (audioStream) {
        await streamAudioToWebSocket(audioStream);
    }
}

// Start the service
startService();
