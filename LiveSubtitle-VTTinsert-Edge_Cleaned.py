import base64
import time
from boto3.dynamodb.conditions import Key, Attr
import boto3
from botocore.exceptions import ClientError
import sys, linecache
import re
from botocore.client import Config

# DYNAMO Global Vars
DYNAMO_CONFIG = Config(connect_timeout=0.250, read_timeout=0.250, retries={'max_attempts': 1})
DYNAMO_RESOURCE = boto3.resource('dynamodb', config=DYNAMO_CONFIG)
DYNAMO_TABLE = 'not-set'
DYNAMO_INDEX = "not-set"

# PIPE ID
PIPE_ID = 'not-set'

# CAPTION Global Vars
CAPTION_PASSTHROUGH = False
CAPTION_REPLACE = True
CAPTION_BUFFER = 2

DEBUG = True

def get_environment_variables(request):
    global DEBUG
    global CAPTION_PASSTHROUGH
    global CAPTION_REPLACE
    global CAPTION_BUFFER
    global DYNAMO_INDEX
    global DYNAMO_TABLE
    global PIPE_ID

    try:
        ## Optional Variables - Debugging / Metrics
        if 'cf5k-debug' in request:
            DEBUG = str_to_bool(request['cf5k-debug'][0]['value'])
            if DEBUG: 
                print('DEBUG GLOBAL customHeader DEBUG: {}'.format(DEBUG))
        if DEBUG:
            print('DEBUG raw list of customHeader: {}'.format(request))

        ## Optional Variables - Features
        if 'caption_passthrough' in request:
            CAPTION_PASSTHROUGH = str_to_bool(request['caption_passthrough'][0]['value'])
            if DEBUG: 
                print('DEBUG GLOBAL customHeader CAPTION_PASSTHROUGH: {}'.format(CAPTION_PASSTHROUGH))
        
        if 'caption_replace' in request:
            CAPTION_REPLACE = str_to_bool(request['caption_replace'][0]['value'])
            if DEBUG: 
                print('DEBUG GLOBAL customHeader CAPTION_REPLACE: {}'.format(CAPTION_REPLACE))
        
        if 'caption_buffer' in request:
            CAPTION_BUFFER = str_to_bool(request['caption_buffer'][0]['value'])
            if DEBUG: 
                print('DEBUG GLOBAL customHeader CAPTION_BUFFER: {}'.format(CAPTION_BUFFER))

        ## Mandatory Variables - DynamoDB configuration
        if 'dynamo_index' in request:
            DYNAMO_INDEX = request['dynamo_index'][0]['value']
            if DEBUG: 
                print('DEBUG GLOBAL customHeader DYNAMO_INDEX: {}'.format(DYNAMO_INDEX))
        else:
            print("ERROR GLOBAL customHeader DYNAMO_INDEX NOT FOUND!")
            return False
        
        if 'dynamo_table' in request:
            DYNAMO_TABLE = request['dynamo_table'][0]['value']
            if DEBUG: 
                print('DEBUG GLOBAL customHeader DYNAMO_TABLE: {}'.format(DYNAMO_TABLE))
        else:
            print("ERROR GLOBAL customHeader DYNAMO_TABLE NOT FOUND!")
            return False
        
        if 'pipe_id' in request:
            PIPE_ID = request['pipe_id'][0]['value']
            if DEBUG: 
                print('DEBUG GLOBAL customHeader PIPE_ID: {}'.format(PIPE_ID))
        else:
            print("ERROR GLOBAL customHeader PIPE_ID NOT FOUND!")
            return False
    except: 
        print("ERROR get_environment_variables Exception")
        print_exception()
        return False

    return True

def str_to_bool(s):
    return s in ['True', 'true']

def print_exception():
    """Informative exception handler"""
    exc_type, exc_obj, tb = sys.exc_info()
    f = tb.tb_frame
    lineno = tb.tb_lineno
    filename = f.f_code.co_filename
    linecache.checkcache(filename)
    line = linecache.getline(filename, lineno, f.f_globals)
    print('ERROR EXCEPTION IN ({}, LINE {} "{}"): {} {}'.format(filename, lineno, line.strip(), exc_type, exc_obj))

def caption_latest(pipe_id, lang_id):
    if DEBUG:
        print("DEBUG caption_latest(pipe_id, lang_id): {}, {}".format(pipe_id, lang_id))
    
    messages_table = DYNAMO_RESOURCE.Table(DYNAMO_TABLE)
    
    try:
        response = messages_table.query(
            KeyConditionExpression=Key('id_lang').eq(lang_id),
            ScanIndexForward=False,
            Limit=5,
            IndexName=DYNAMO_INDEX,
            ProjectionExpression='timestamp_created, transcript_transcript, transcript_endtime, transcript_starttime',
            FilterExpression=Attr("id_pipe").eq(pipe_id)
        )
    except ClientError as e:
        print("ERROR DynamoDB: %s" % e)
        return False
    
    if len(response["Items"]) < 1:
        print("ERROR DynamoDB: item list is empty")
        return False

    if not response["Items"][0]:
        print("ERROR no current_caption!")
        return False

    caption_string = response["Items"][0]['transcript_transcript']
    caption_latency = float(time.time()) - float(response["Items"][0]['timestamp_created'])
    
    # Check if caption duration is less than buffer threshold
    caption_duration = float(response["Items"][0]['transcript_endtime']) - float(response["Items"][0]['transcript_starttime'])
    
    if caption_duration < float(CAPTION_BUFFER):
        if DEBUG:
            print("DEBUG newest caption is smaller than CAPTION_BUFFER")
        
        # Combine with previous captions
        caption_string = ""
        for item in response["Items"][1:]:
            caption_string = item['transcript_transcript'] + "\n" + caption_string
            caption_latency = float(time.time()) - float(item['timestamp_created'])
            item_duration = float(item['transcript_endtime']) - float(item['transcript_starttime'])
            if item_duration > float(CAPTION_BUFFER):
                break
    
    if DEBUG: 
        print("DEBUG caption_string: {}".format(caption_string))
        print("DEBUG caption_latency: {}".format(caption_latency))

    return caption_string

def lambda_handler(event, context):
    request = event['Records'][0]['cf']['request'].copy()
    untouched_request = request.copy()
    
    if request['method'] != 'PUT':
        print("INFO Request Method is: {} skipping...".format(request['method']))
        return untouched_request
    
    # Check for environment variables in customHeader
    if not get_environment_variables(request['origin']['custom'].pop('customHeaders')):
        print("ERROR GLOBALS not set sending request untouched")
        return untouched_request
    
    try:
        if DEBUG:
            print("DEBUG CF Request: {}".format(request))
        
        request['headers']['user-agent'][0]['value'] = "AWS Lambda"
        
        # Decode .vtt contents
        try: 
            og_body = base64.b64decode(request['body']['data']).decode("utf-8")
            if DEBUG:
                print("DEBUG CF Body base64 decoded: {}".format(og_body))
        except Exception as e:
            print("ERROR base64decode: %s" % e)
            return untouched_request

        if CAPTION_PASSTHROUGH:
            print("INFO CAPTION_PASSTHROUGH Global is TRUE, skipping autocaptions")
            return untouched_request
        
        if CAPTION_REPLACE:
            new_body = []
            caption_detected = False
            for this_line in og_body.splitlines():
                if re.search(r'\d{2,}:\d{2}:\d{2}\.\d{3} --> \d{2,}:\d{2}:\d{2}\.\d{3}', this_line):
                    print("WARNING Caption Detected!")
                    caption_detected = True
                    break
                else:
                    new_body.append(this_line)
            
            new_body.append('')
            if caption_detected:
                print("WARNING Caption Scrubbed")
                og_body = "\n".join(new_body)
        else:
            print("WARNING CAPTION_REPLACE Global is FALSE, skipping autocaptions")
            return untouched_request
        
        # Extract language ID from URI
        r = re.search(r'index_(\w{2})_\d{1,}\.vtt', request['uri'])
        if not r: 
            print("ERROR REGEX for lang_id failed, skipping autocaptions")
            return untouched_request
        
        lang_id = r.group(1)
        if DEBUG: 
            print("DEBUG lang_id: {}".format(lang_id))
        
        # Get caption text from dynamo
        latest_caption_text = caption_latest(PIPE_ID, lang_id)
        if latest_caption_text == False:
            print("ERROR Caption is False, passthrough unmodified request")
            return untouched_request

        # Append new caption to vtt file
        try:
            vtt = og_body.splitlines()
            vtt.append("00:00:00.000 --> 1000000:00:00.000 line:13 position:5% align:left size:90%")
            vtt.append(latest_caption_text)
            vtt.append('')
            vtt_file = "\n".join(vtt)
            
            request['body']['action'] = 'replace'
            request['body']['encoding'] = 'text'
            request['body']['data'] = str(vtt_file)
            
            if DEBUG:
                print("DEBUG after body: {}".format(request['body']['data']))
            
            return request
        except:
            print("ERROR cannot combine og_body with new captions")
            print_exception()
            return untouched_request
    except: 
        print("ERROR Outer Lambda Exception")
        print_exception()
        return untouched_request