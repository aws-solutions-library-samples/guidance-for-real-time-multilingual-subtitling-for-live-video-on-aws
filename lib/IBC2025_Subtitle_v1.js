const { PassThrough } = require("stream");
const { spawn } = require("child_process");
var util_utf8_node = require("@aws-sdk/util-utf8-node")
const { TranscribeStreamingClient, StartStreamTranscriptionCommand} = require("@aws-sdk/client-transcribe-streaming");
const { TranslateClient, TranslateTextCommand} = require("@aws-sdk/client-translate");

const REGION = process.env.REGION || "us-east-1";
//const TABLE_NAME = process.env.TABLE_NAME || "arn:aws:dynamodb:ap-south-1:776017853864:table/LiveSubtitle-edge-VTT-CaptionsDynamoTable-1";
const TABLE_NAME = process.env.TABLE_NAME || "SubtitleTable";
const ID_PIPE = process.env.ID_PIPE || "pipe0";
const VOCABULARYNAME = process.env.VOCABULARY_NAME;
const LANGUAGECODE = process.env.LANGUAGE_CODE;
const VOCABULARYFILTERNAME = process.env.VOCABULARY_FILTER_NAME;
const VOCABULARYFILTERMETHOD = process.env.VOCABULARY_FILTER_METHOD;

// Translation configuration
const ENABLE_TRANSLATION = process.env.ENABLE_TRANSLATION === 'true' || true;
const SOURCE_LANGUAGE = process.env.SOURCE_LANGUAGE || 'en';
const CAPTION_LANGUAGES = process.env.CAPTION_LANGUAGES || 'en, hi, es, ko, de';

var languageCode = LANGUAGECODE || "en-US";
var MediaSampleRateHertz = 16000;

var runFFMPEG = function(){
    const ls = spawn("ffmpeg", [
        "-re", "-i", "udp://127.0.0.1:7950", 
        "-tune", "zerolatency", 
        "-f", "wav", "-ac", "1", 
        "-fflags", "+discardcorrupt",
        "-"
    ], { detached: true });

    ls.stderr.on("data", data => {
        const errorMsg = data.toString();
        if (!errorMsg.includes('PES packet size mismatch') && 
            !errorMsg.includes('Packet corrupt') && 
            !errorMsg.includes('size=') && 
            !errorMsg.includes('time=') && 
            !errorMsg.includes('bitrate=') && 
            !errorMsg.includes('speed=')) {
            console.log(`stderr: ${errorMsg}`);
        }
    });

    ls.on('error', (error) => {
        console.error('FFmpeg error:', error.message);
        setTimeout(() => {
            const newStream = runFFMPEG();
            streamAudioToWebSocket(newStream);
        }, 3000);
    });

    ls.on("close", code => {
        if (code !== 0) {
            setTimeout(() => {
                const newStream = runFFMPEG();
                streamAudioToWebSocket(newStream);
            }, 3000);
        }
    });

    return ls;
}

let streamAudioToWebSocket = async function (audioStream) {
    try {
        const audioPayloadStream = new PassThrough({ highWaterMark: 1*1024 })
        audioStream.stdout.pipe(audioPayloadStream);

        audioPayloadStream.on('error', (error) => {
            console.error('Audio payload stream error:', error);
        });

        const transcribeInput = async function* () {
            try {
                for await(const chunk of audioPayloadStream) {
                    yield {AudioEvent: {AudioChunk: chunk}}
                }
            } catch (error) {
                console.error('Transcribe input error:', error);
            }
        }

        const client = new TranscribeStreamingClient({
            region: REGION
        });

        const res = await client.send(new StartStreamTranscriptionCommand({
            LanguageCode: languageCode,
            MediaSampleRateHertz: MediaSampleRateHertz,
            MediaEncoding: 'pcm',
            VocabularyName: VOCABULARYNAME,
            VocabularyFilterName: VOCABULARYFILTERNAME,
            VocabularyFilterMethod: VOCABULARYFILTERMETHOD,
            AudioStream: transcribeInput()
        }));

        for await(const event of res.TranscriptResultStream) {
            if(event.TranscriptEvent) {
                const message = event.TranscriptEvent;
                handleEventStreamMessagedynamo(message);
            }
        }
    } catch (error) {
        console.error('Transcription stream error:', error);
        setTimeout(() => {
            const newAudioStream = runFFMPEG();
            streamAudioToWebSocket(newAudioStream);
        }, 5000);
    }
}

var AWS = require('aws-sdk');

AWS.config.update({
    region: REGION
});

let handleEventStreamMessagedynamo = function (messageJson) {
    let results = messageJson.Transcript.Results;

    if (results.length > 0 && results[0].Alternatives.length > 0 && results[0].IsPartial === false) {
        let transcript = results[0].Alternatives[0].Transcript;
        transcript = decodeURIComponent(escape(transcript));
        
        console.log(transcript);
        console.log("==Results==> ",JSON.stringify(results[0], null, 2))
        processTranscriptSegments(results[0]);
    }
}

async function processTranscriptSegments(result) {
    const transcript = result.Alternatives[0].Transcript;
    //console.log("==transcript==> ", transcript);
    const items = result.Alternatives[0].Items;
    //console.log("==items==> ", items);
    //console.log("==resultID==> ", result.ResultId);
    const segments = createSegments(transcript, result.ResultId, items);
    
    // Store original segments
    for (const segment of segments) {
        console.log("==segmentdynamo==> ", segment);
        await putDynamo(segment);
    }
    
    // Process translations if enabled
    if (ENABLE_TRANSLATION) {
        await processTranslations(transcript, segments);
    }
}

function createSegments(transcript, resultId, items) {
    const segments = [];
    const charlength = 140;
    let start = 0;
    let partIndex = 0;
    
    // Build word timing map and find overall end time
    const wordTimingMap = buildWordTimingMap(transcript, items);
    const overallEndTime = findOverallEndTime(items);
    const currentTimestamp = timestamp_millis();
    
    while (start < transcript.length) {
        let end = Math.min(start + charlength, transcript.length);
        console.log("==end==> ", end)
        
        // Adjust to word boundary
        if (end < transcript.length && transcript[end] !== ' ') {
            let lastSpace = transcript.lastIndexOf(' ', end);
            if (lastSpace > start) {
                end = lastSpace;
            }
        }
        
        const currentPart = transcript.substring(start, end).trim();
        console.log("==currentPart==> ", currentPart)
        const currentID = partIndex === 0 ? resultId : `${resultId}-${partIndex}`;
        console.log("==currentID==> ", currentID)
        
        // Find timing for this segment
        const timing = findSegmentTiming(currentPart, wordTimingMap, start);
        
        // Calculate timestamps based on time remaining until end
        const timeUntilEnd = overallEndTime - timing.endTime;
        const segmentTimestamp = currentTimestamp - Math.floor(timeUntilEnd * 1000);
        
        const segment = {
            id_name: currentID,
            id_status: "ready",
            sort_starttime: segmentTimestamp * 1000,
            id_session: String(segmentTimestamp),
            id_pipe: ID_PIPE,
            id_lang: "en",
            timestamp_created: Math.floor(currentTimestamp / 1000),
            timestamp_ttl: Math.floor(currentTimestamp / 1000) + 7200,
            transcript_transcript: currentPart,
            transcript_starttime: String(timing.startTime.toFixed(2)),
            transcript_endtime: String(timing.endTime.toFixed(2)),
            transcript_resultid: String(resultId),
            transcript_ispartial: false
        };
        console.log("==segment==> ", segment)
        
        segments.push(segment);
        console.log("==segments.push==> ", segments)
        
        start = end;
        while (start < transcript.length && transcript[start] === ' ') {
            start++;
        }
        partIndex++;
    }
    
    return segments;
}

function buildWordTimingMap(transcript, items) {
    const wordTimingMap = new Map();
    let currentPosition = 0;
    
    if (!items || items.length === 0) return wordTimingMap;
    
    for (const item of items) {
        if (item.Type === "pronunciation") {
            const wordPosition = transcript.indexOf(item.Content, currentPosition);
            if (wordPosition !== -1) {
                if (!wordTimingMap.has(item.Content)) {
                    wordTimingMap.set(item.Content, []);
                }
                wordTimingMap.get(item.Content).push({
                    startPos: wordPosition,
                    startTime: item.StartTime,
                    endTime: item.EndTime
                });
                currentPosition = wordPosition + item.Content.length;
            }
        }
    }
    console.log("==wordTimimgMap==> ", wordTimingMap)
    return wordTimingMap;
}

function findOverallEndTime(items) {
    let maxEndTime = 0;
    if (!items || items.length === 0) return maxEndTime;
    
    for (const item of items) {
        if (item.Type === "pronunciation" && item.EndTime > maxEndTime) {
            maxEndTime = item.EndTime;
        }
    }
    return maxEndTime;
}

function findSegmentTiming(segment, wordTimingMap, segmentStartPos = 0) {
    const words = segment.split(' ');
    let firstWord = words[0];
    let lastWord = words[words.length - 1];
    
    // Remove punctuation from first and last words to match wordTimingMap
    firstWord = firstWord.replace(/[.,!?;:]$/, '');
    lastWord = lastWord.replace(/[.,!?;:]$/, '');
    
    let startTime = 0;
    let endTime = 0;
    
    // Find start time from first word - get the occurrence closest to segment start
    if (wordTimingMap.has(firstWord)) {
        const occurrences = wordTimingMap.get(firstWord);
        let bestMatch = occurrences[0];
        let minDistance = Math.abs(occurrences[0].startPos - segmentStartPos);
        
        for (const occurrence of occurrences) {
            const distance = Math.abs(occurrence.startPos - segmentStartPos);
            if (distance < minDistance) {
                minDistance = distance;
                bestMatch = occurrence;
            }
        }
        startTime = bestMatch.startTime;
    }
    
    // Find end time from last word - get the occurrence closest to where last word should be
    if (wordTimingMap.has(lastWord)) {
        const occurrences = wordTimingMap.get(lastWord);
        const lastWordPos = segmentStartPos + segment.lastIndexOf(lastWord);
        let bestMatch = occurrences[0];
        let minDistance = Math.abs(occurrences[0].startPos - lastWordPos);
        
        for (const occurrence of occurrences) {
            const distance = Math.abs(occurrence.startPos - lastWordPos);
            if (distance < minDistance) {
                minDistance = distance;
                bestMatch = occurrence;
            }
        }
        endTime = bestMatch.endTime;
    }
    
    return { startTime, endTime };
}

async function getTranslation(sourceLang, targetLang, text) {
    try {
        const translateClient = new TranslateClient({ region: REGION });
        const command = new TranslateTextCommand({
            Text: text,
            SourceLanguageCode: sourceLang,
            TargetLanguageCode: targetLang
        });
        const response = await translateClient.send(command);
        return response.TranslatedText;
    } catch (error) {
        console.error("Translation error:", error);
        return text;
    }
}

async function processTranslations(originalTranscript, originalSegments) {
    const languages = CAPTION_LANGUAGES.split(',').map(lang => lang.trim());
    
    for (const lang of languages) {
        if (lang !== SOURCE_LANGUAGE) {
            try {
                const translatedText = await getTranslation(SOURCE_LANGUAGE, lang, originalTranscript);
                console.log("==translatedText==> ", translatedText)
                const translatedSegments = createTranslatedSegments(translatedText, originalSegments, lang);
                
                for (const segment of translatedSegments) {
                    await putDynamo(segment);
                }
            } catch (error) {
                console.error(`Error processing translation for ${lang}:`, error);
            }
        }
    }
}

function createTranslatedSegments(translatedText, originalSegments, language) {
    const segments = [];
    const charlength = 140;
    let start = 0;
    let segmentIndex = 0;
    
    while (start < translatedText.length && segmentIndex < originalSegments.length) {
        let end = Math.min(start + charlength, translatedText.length);
        
        // Adjust to word boundary
        if (end < translatedText.length && translatedText[end] !== ' ') {
            let lastSpace = translatedText.lastIndexOf(' ', end);
            if (lastSpace > start) {
                end = lastSpace;
            }
        }
        console.log("==endtranslated==> ", end)
        const currentPart = translatedText.substring(start, end).trim();
        console.log("==currentParttranslated==> ", currentPart)
        const originalSegment = originalSegments[segmentIndex];
        console.log("==originalSegmenttranslated==> ", originalSegment)
        
        const segment = {
            ...originalSegment,
            id_name: `${originalSegment.id_name}-${language}`,
            id_lang: language,
            transcript_transcript: currentPart
        };
        console.log("==segmenttranslated==> ", segment)
        
        segments.push(segment);
        console.log("==segments.pushtranslated==> ", segments)
        
        start = end;
        while (start < translatedText.length && translatedText[start] === ' ') {
            start++;
        }
        segmentIndex++;
    }
    
    return segments;
}

function putDynamo(dynamoObject) {
    const dynamoClient = new AWS.DynamoDB.DocumentClient();
    const params = {
        TableName: TABLE_NAME,
        Item: dynamoObject
    };

    return new Promise((resolve, reject) => {
        dynamoClient.put(params, function(err, data) {
            if (err) {
                console.error("ERROR ClientError:", err);
                reject(err);
            } else {
                resolve(data);
            }
        });
    });
}

function timestamp_millis(){
    return parseInt(Date.now(), 10);
}

console.log("=== Subtitle Translation Service v1 Starting ===");
console.log("Translation enabled:", ENABLE_TRANSLATION);
if (ENABLE_TRANSLATION) {
    console.log("Source language:", SOURCE_LANGUAGE);
    console.log("Target languages:", CAPTION_LANGUAGES);
}

var audioStream = runFFMPEG();
streamAudioToWebSocket(audioStream);
