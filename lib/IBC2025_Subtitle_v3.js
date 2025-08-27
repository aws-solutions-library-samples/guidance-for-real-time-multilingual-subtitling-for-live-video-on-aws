const { spawn } = require('child_process');
const { PassThrough } = require('stream');
const { TranscribeStreamingClient, StartStreamTranscriptionCommand } = require('@aws-sdk/client-transcribe-streaming');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const AWS = require('aws-sdk');

// Configuration
const REGION = process.env.AWS_REGION || 'us-east-1';
const SOURCE_LANGUAGE = process.env.SOURCE_LANGUAGE || 'en';
const CAPTION_LANGUAGES = process.env.CAPTION_LANGUAGES || 'en,ko,de,es,hi';
const DYNAMODB_TABLE = process.env.DYNAMODB_TABLE || 'SubtitleTable';
const languageCode = process.env.LANGUAGE_CODE || 'en-US';
const CustomVocabulary = process.env.VOCABULARY_NAME || 'custom-vocabulary';
const MediaSampleRateHertz = 16000;

// AWS clients
const dynamodb = new AWS.DynamoDB.DocumentClient({ region: REGION });
const dynamodbClient = new AWS.DynamoDB({ region: REGION });
const bedrockClient = new BedrockRuntimeClient({ region: 'us-east-1' });

let wordBuffer = [];
let accumulatedItems = [];
let currentFFmpegProcess = null;

// Check if RTP stream is available by testing FFmpeg connection
function checkRTPStream() {
    return new Promise((resolve) => {
        const testProcess = spawn('ffmpeg', [
            '-hide_banner',
            '-loglevel', 'info',
            '-i', 'rtp://127.0.0.1:5000',
            '-t', '0.1',
            '-f', 'null',
            '-'
        ]);
        
        let hasStream = false;
        let hasError = false;
        
        testProcess.stderr.on('data', (data) => {
            const output = data.toString();
            // Check for successful stream detection
            if (output.includes('Stream #0:') || output.includes('Input #0')) {
                hasStream = true;
            }
            // Check for actual errors
            if (output.includes('Connection refused') || output.includes('No route to host') || 
                output.includes('Input/output error') || output.includes('Invalid data found') ||
                output.includes('bind failed') || output.includes('Address already in use') ||
                output.includes('Protocol not found') || output.includes('No such file')) {
                hasError = true;
            }
        });
        
        testProcess.on('close', (code) => {
            resolve(hasStream && !hasError);
        });
        
        setTimeout(() => {
            testProcess.kill('SIGKILL');
            resolve(hasStream && !hasError);
        }, 5000);
    });
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

// FFmpeg with RTP availability check
async function runFFMPEG() {
    console.log('Checking RTP stream availability...');
    const isRTPAvailable = true; // 기존, const isRTPAvailable = await checkRTPStream();
    
    if (!isRTPAvailable) {
        console.log('RTP stream not available, retrying in 10 seconds...');
        setTimeout(startService, 10000);
        return null;
    }
    
    console.log('RTP stream available, starting FFmpeg...');
    killExistingFFmpeg();
    
    const ls = spawn("ffmpeg", [
        "-thread_queue_size", "1024",
        "-reorder_queue_size", "25000",
        "-buffer_size", "2048k",
        "-i", "rtp://127.0.0.1:5000",
        "-map", "0:a",
        "-acodec", "pcm_s16le",
        "-f", "wav",
        "-ac", "1",
        "-ar", "16000",
        "-fflags", "+discardcorrupt+nobuffer",
        "-max_delay", "500000",
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

    ls.on('error', () => {
        console.log('FFmpeg error, restarting...');
        setTimeout(startService, 10000);
    });
    
    ls.on("close", code => {
        if (code !== 0) {
            console.log(`FFmpeg closed with code ${code}, restarting...`);
            setTimeout(startService, 10000);
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
        const audioPayloadStream = new PassThrough({ highWaterMark: 1024 });
        audioStream.stdout.pipe(audioPayloadStream);

        const transcribeInput = async function* () {
            for await(const chunk of audioPayloadStream) {
                yield { AudioEvent: { AudioChunk: chunk } };
            }
        };

        const client = new TranscribeStreamingClient({ region: REGION });
        const res = await client.send(new StartStreamTranscriptionCommand({
            LanguageCode: languageCode,
            MediaSampleRateHertz: MediaSampleRateHertz,
            MediaEncoding: 'pcm',
            VocabularyName: CustomVocabulary,
            AudioStream: transcribeInput()
        }));

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
                    //console.log("==Results==> ",JSON.stringify(result, null, 2));
                    
                    if (!IsPartial) {
                        console.log("==Results==> ",JSON.stringify(result, null, 2));
                        console.log(result.Alternatives[0].Transcript);
                        await processTranscript(result);
                    }
                }
            }
        }
    } catch (error) {
        console.error('Transcription error:', error);
        setTimeout(startService, 10000);
    }
}

// Process transcript and accumulate items
async function processTranscript(result) {
    const { ResultId, IsPartial, Alternatives, EndTime, StartTime, sessionStartTime } = result;
    const items = Alternatives[0].Items;
    const transcript = Alternatives[0].Transcript;
    //const currentTime = Date.now() - (EndTime - StartTime) * 1000;
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
            
            // Translate remaining segments
            //await translateAndStore(transcript, ResultId, remainingSegments, currentTime, IsPartial);
            
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
    //console.log("==Storing completed segments==", JSON.stringify(records, null, 2))

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

// Translate and store with equal word distribution segmentation
async function translateAndStore(transcript, resultId, originalChunks, currentTime, isPartial) {
    const targetLanguages = CAPTION_LANGUAGES.split(',').map(lang => lang.trim()).filter(lang => lang !== SOURCE_LANGUAGE);
    
    for (const targetLang of targetLanguages) {
        try {
            console.log("==Full transcript for translation==> ", transcript)
            
            // Translate the full transcript once for better context using Bedrock
            const prompt = `You are expert translator and subtitling specialist. Your task is to translate the following subtitle text from ${SOURCE_LANGUAGE} to ${targetLang}. Return only the translated text without any additional explanation or formatting:\n\n${transcript}`;
            console.log("==Prompt for translation==> ", prompt)
            const command = new InvokeModelCommand({
                modelId: "amazon.nova-lite-v1:0",
                contentType: "application/json",
               body: JSON.stringify({
                messages: [
                    { 
                        role: "user", 
                        content: [{ text: prompt }] 
                    }
                ],
                inferenceConfig: {
                    maxTokens: 1000,
                    temperature: 0.1,
                    //top_k: 250,
                    top_p: 0.9,
                    stopSequences: []
                }
            })
            });
            
            const response = await bedrockClient.send(command);
            const responseBody = JSON.parse(new TextDecoder().decode(response.body));
            const fullTranslatedText = responseBody.output.message.content[0].text.trim();
            console.log("==Full translated text==> ", fullTranslatedText)
            
            // Segment translated text based on original chunk count
            const totalSegments = originalChunks.length;
            const translatedWords = fullTranslatedText.split(/\s+/);
            const totalWords = translatedWords.length;
            const wordsPerSegment = Math.ceil(totalWords / totalSegments);
            
            console.log(`==Segmentation: ${totalWords} words / ${totalSegments} segments = ${wordsPerSegment} words per segment==`);
            
            const translatedRecords = [];
            let wordIndex = 0;
            
            // Create segments with equal word distribution
            for (let chunkIndex = 0; chunkIndex < originalChunks.length; chunkIndex++) {
                const chunk = originalChunks[chunkIndex];
                
                // Calculate words for this segment (last segment gets remaining words)
                const isLastSegment = chunkIndex === originalChunks.length - 1;
                const segmentWordCount = isLastSegment ? totalWords - wordIndex : wordsPerSegment;
                
                // Extract words for this segment
                const segmentWords = translatedWords.slice(wordIndex, wordIndex + segmentWordCount);
                wordIndex += segmentWordCount;
                
                if (segmentWords.length === 0) continue;
                
                // Preserve exact timing from original chunk
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
        } catch (error) {
            console.error(`Translation error for ${targetLang}:`, error);
        }
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

// Start service function
async function startService() {
    const audioStream = await runFFMPEG();
    if (audioStream) {
        await streamAudioToWebSocket(audioStream);
    }
}

// Start the service
startService();