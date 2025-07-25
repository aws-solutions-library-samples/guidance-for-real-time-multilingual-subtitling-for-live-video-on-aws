#!/usr/bin/env python3
# HLS segment and transcript real-time monitoring script
import requests
import time
import re
from datetime import datetime, timedelta
import sys
import boto3
from decimal import Decimal

# Configuration variables
MEDIAPACKAGE_HLS_URL = "https://82934cf9c8696bd2.mediapackage.us-east-1.amazonaws.com/out/v1/e487dc2d9605417ea1e09b6f43b5cc33/index.m3u8"
SEGMENT_DURATION = 2
MONITOR_INTERVAL = 2
DYNAMODB_TABLE_NAME = "SubtitleTable"
AWS_REGION = "us-east-1"

class TranscriptRetriever:
    def __init__(self, table_name, region='us-east-1'):
        self.dynamodb = boto3.resource('dynamodb', region_name=region)
        self.table = self.dynamodb.Table(table_name)
        
    def get_transcript_by_time_range(self, start_time, end_time, session_id=None):
        # Query transcripts from DynamoDB by time range
        try:
            filter_expression = "startTime >= :start_time AND endTime <= :end_time"
            expression_values = {
                ':start_time': Decimal(str(start_time)),
                ':end_time': Decimal(str(end_time))
            }
            
            if session_id:
                filter_expression += " AND sessionId = :session_id"
                expression_values[':session_id'] = session_id
            
            response = self.table.scan(
                FilterExpression=filter_expression,
                ExpressionAttributeValues=expression_values
            )
            
            items = response.get('Items', [])
            items.sort(key=lambda x: float(x.get('startTime', 0)))
            
            return items
            
        except Exception as e:
            return []
    
    def get_transcript_at_time(self, target_time, session_id=None, tolerance=1.0):
        # Query transcript at specific time
        start_range = target_time - tolerance
        end_range = target_time + tolerance
        
        transcripts = self.get_transcript_by_time_range(start_range, end_range, session_id)
        
        if transcripts:
            closest_transcript = min(transcripts, 
                key=lambda x: abs(float(x.get('startTime', 0)) - target_time))
            return closest_transcript
        
        return None

class OptimalFirstSegmentDetector:
    def __init__(self):
        self.previous_discontinuity_seq = None
        self.previous_media_sequence = None
        self.previous_segments = []
        self.video_start_points = []
        self.current_video_start_sequence = None
        self.monitoring_start_time = time.time()
        
        # Initialize transcript retriever
        try:
            self.transcript_retriever = TranscriptRetriever(DYNAMODB_TABLE_NAME, AWS_REGION)
        except Exception as e:
            self.transcript_retriever = None
    
    def extract_discontinuity_sequence(self, manifest_content):
        # Extract DISCONTINUITY-SEQUENCE value
        match = re.search(r'#EXT-X-DISCONTINUITY-SEQUENCE:(\d+)', manifest_content)
        return int(match.group(1)) if match else 0
    
    def extract_media_sequence(self, manifest_content):
        # Extract MEDIA-SEQUENCE value
        match = re.search(r'#EXT-X-MEDIA-SEQUENCE:(\d+)', manifest_content)
        return int(match.group(1)) if match else 1
    
    def extract_segments(self, manifest_content):
        # Extract segment list from manifest
        lines = manifest_content.strip().split('\n')
        segments = []
        
        for line in lines:
            if line.endswith('.ts'):
                segments.append(line.strip())
        
        return segments
    
    def find_first_segment_after_discontinuity(self, manifest_content):
        # Find first segment after DISCONTINUITY
        lines = manifest_content.strip().split('\n')
        media_sequence = self.extract_media_sequence(manifest_content)
        
        # Priority 1: After DISCONTINUITY tag
        for i, line in enumerate(lines):
            if line.strip() == '#EXT-X-DISCONTINUITY':
                for j in range(i+1, len(lines)):
                    if lines[j].endswith('.ts'):
                        segment_index = sum(1 for k in range(j) if lines[k].endswith('.ts'))
                        return {
                            'filename': lines[j].strip(),
                            'sequence': media_sequence + segment_index,
                            'method': 'discontinuity_tag',
                            'confidence': 'high'
                        }
        
        # Priority 2: First segment in manifest
        for i, line in enumerate(lines):
            if line.endswith('.ts'):
                return {
                    'filename': line.strip(),
                    'sequence': media_sequence,
                    'method': 'first_in_manifest',
                    'confidence': 'medium'
                }
        
        return None
    
    def detect_video_start(self, manifest_content):
        # Detect video start point
        current_discontinuity = self.extract_discontinuity_sequence(manifest_content)
        discontinuity_increased = (
            self.previous_discontinuity_seq is not None and 
            current_discontinuity > self.previous_discontinuity_seq
        )
        
        has_discontinuity_tag = '#EXT-X-DISCONTINUITY' in manifest_content
        
        current_media_seq = self.extract_media_sequence(manifest_content)
        sequence_reset = (
            self.previous_media_sequence is not None and
            current_media_seq < self.previous_media_sequence
        )
        
        segments = self.extract_segments(manifest_content)
        manifest_recovered = len(segments) > 0 and len(self.previous_segments) == 0
        
        is_video_start = (
            discontinuity_increased or 
            has_discontinuity_tag or 
            sequence_reset or 
            manifest_recovered
        )
        
        if is_video_start:
            first_segment = self.find_first_segment_after_discontinuity(manifest_content)
            if first_segment:
                self.current_video_start_sequence = first_segment['sequence']
                return self.record_video_start(first_segment, {
                    'discontinuity_increased': discontinuity_increased,
                    'has_discontinuity_tag': has_discontinuity_tag,
                    'sequence_reset': sequence_reset,
                    'manifest_recovered': manifest_recovered
                })
        
        self.previous_discontinuity_seq = current_discontinuity
        self.previous_media_sequence = current_media_seq
        self.previous_segments = segments
        
        return None
    
    def record_video_start(self, segment_info, detection_reasons):
        # Record video start point
        timestamp = datetime.now()
        
        start_record = {
            'timestamp': timestamp,
            'segment': segment_info,
            'detection_reasons': detection_reasons,
            'confidence_score': self.calculate_confidence(detection_reasons)
        }
        
        self.video_start_points.append(start_record)
        return start_record
    
    def calculate_confidence(self, detection_reasons):
        # Calculate detection confidence score
        score = 0
        if detection_reasons['discontinuity_increased']: score += 40
        if detection_reasons['has_discontinuity_tag']: score += 30
        if detection_reasons['sequence_reset']: score += 20
        if detection_reasons['manifest_recovered']: score += 10
        return min(score, 100)
    
    def calculate_original_video_time(self, current_sequence):
        # Calculate original video time for current segment
        if self.current_video_start_sequence is None:
            return None
        
        elapsed_segments = current_sequence - self.current_video_start_sequence
        start_time = elapsed_segments * SEGMENT_DURATION
        end_time = start_time + SEGMENT_DURATION
        
        return {
            'start_time': start_time,
            'end_time': end_time,
            'elapsed_segments': elapsed_segments
        }
    
    def get_transcript_for_segment(self, segment_info, original_time):
        # Get transcript for segment
        if not self.transcript_retriever or not original_time:
            return None
        
        try:
            transcripts = self.transcript_retriever.get_transcript_by_time_range(
                original_time['start_time'], 
                original_time['end_time']
            )
            
            if transcripts:
                return transcripts
            
            closest_transcript = self.transcript_retriever.get_transcript_at_time(
                original_time['start_time']
            )
            
            return [closest_transcript] if closest_transcript else []
            
        except Exception as e:
            return []

class HLSMonitor:
    def __init__(self, manifest_url, segment_duration=1):
        self.manifest_url = manifest_url
        self.segment_duration = segment_duration
        self.previous_segments = set()
        self.start_time = datetime.now()
        self.detector = OptimalFirstSegmentDetector()
        
    def fetch_manifest(self):
        # Fetch HLS manifest
        try:
            response = requests.get(self.manifest_url, timeout=10)
            response.raise_for_status()
            return response.text
        except requests.RequestException as e:
            return None
    
    def parse_manifest(self, manifest_content):
        # Parse manifest and extract segment information
        if not manifest_content:
            return None
            
        lines = manifest_content.strip().split('\n')
        
        media_sequence = 1
        for line in lines:
            if line.startswith('#EXT-X-MEDIA-SEQUENCE:'):
                media_sequence = int(line.split(':')[1])
                break
        
        segments = []
        segment_duration = self.segment_duration
        
        for i, line in enumerate(lines):
            if line.startswith('#EXTINF:'):
                duration_match = re.search(r'#EXTINF:([0-9.]+)', line)
                if duration_match:
                    segment_duration = float(duration_match.group(1))
            
            elif line.endswith('.ts'):
                segment_number = media_sequence + len(segments)
                segments.append({
                    'filename': line,
                    'number': segment_number,
                    'duration': segment_duration
                })
        
        is_live = '#EXT-X-ENDLIST' not in manifest_content
        
        return {
            'media_sequence': media_sequence,
            'segments': segments,
            'is_live': is_live,
            'total_segments': len(segments),
            'manifest_content': manifest_content
        }
    
    def print_segment_info(self, parsed_data):
        # Print segment information
        if not parsed_data:
            return
        
        video_start = self.detector.detect_video_start(parsed_data['manifest_content'])
        
        current_segments = set()
        for segment in parsed_data['segments']:
            segment_key = f"{segment['number']}_{segment['filename']}"
            current_segments.add(segment_key)
            
            if segment_key not in self.previous_segments:
                original_time = self.detector.calculate_original_video_time(segment['number'])
                
                if original_time:
                    transcripts = self.detector.get_transcript_for_segment(segment, original_time)
                    # Process transcript data if needed
        
        self.previous_segments = current_segments
    
    def monitor(self, interval=5):
        # Monitor manifest at specified intervals
        try:
            while True:
                manifest_content = self.fetch_manifest()
                parsed_data = self.parse_manifest(manifest_content)
                self.print_segment_info(parsed_data)
                
                time.sleep(interval)
                
        except KeyboardInterrupt:
            elapsed = datetime.now() - self.start_time

def main():
    # HLS segment and transcript monitoring tool
    hls_url = MEDIAPACKAGE_HLS_URL
    segment_duration = SEGMENT_DURATION
    monitor_interval = MONITOR_INTERVAL
    
    if len(sys.argv) > 1:
        hls_url = sys.argv[1]
    
    if len(sys.argv) > 2:
        segment_duration = float(sys.argv[2])
    
    monitor = HLSMonitor(hls_url, segment_duration)
    monitor.monitor(monitor_interval)

if __name__ == "__main__":
    main()
