#!/usr/bin/env python3
"""
HLS 세그먼트 + Transcript 실시간 모니터링 스크립트
MediaPackage에서 HLS 매니페스트를 주기적으로 확인하여 세그먼트 번호와 시간 구간을 계산하고,
DynamoDB에서 해당 시간대의 transcript를 가져옵니다.
"""

import requests
import time
import re
from datetime import datetime, timedelta
import sys
import boto3
from decimal import Decimal

# ========================================
# 🔧 설정 변수 (여기서 수정하세요)
# ========================================

# MediaPackage HLS URL (더 정확한 실시간 감지를 위해)
MEDIAPACKAGE_HLS_URL = "https://82934cf9c8696bd2.mediapackage.us-east-1.amazonaws.com/out/v1/e487dc2d9605417ea1e09b6f43b5cc33/index.m3u8"

# 세그먼트 길이 (초) - MediaPackage 설정과 맞춰주세요
SEGMENT_DURATION = 2  # 2초 세그먼트

# 모니터링 간격 (초)
MONITOR_INTERVAL = 2  # 1초마다 체크 (실시간 감지)

# DynamoDB 설정
DYNAMODB_TABLE_NAME = "SubtitleTable"  # config.json에서 확인한 테이블명
AWS_REGION = "us-east-1"

# ========================================

class TranscriptRetriever:
    def __init__(self, table_name, region='us-east-1'):
        self.dynamodb = boto3.resource('dynamodb', region_name=region)
        self.table = self.dynamodb.Table(table_name)
        
    def get_transcript_by_time_range(self, start_time, end_time, session_id=None):
        """
        시간 범위에 해당하는 transcript를 DynamoDB에서 조회합니다.
        
        Args:
            start_time (float): 시작 시간 (초)
            end_time (float): 종료 시간 (초)
            session_id (str): 세션 ID (옵션)
        
        Returns:
            list: transcript 항목들
        """
        try:
            # DynamoDB 쿼리 조건
            filter_expression = "startTime >= :start_time AND endTime <= :end_time"
            expression_values = {
                ':start_time': Decimal(str(start_time)),
                ':end_time': Decimal(str(end_time))
            }
            
            # 세션 ID가 있으면 추가 필터링
            if session_id:
                filter_expression += " AND sessionId = :session_id"
                expression_values[':session_id'] = session_id
            
            # DynamoDB 스캔 (시간 범위 기반)
            response = self.table.scan(
                FilterExpression=filter_expression,
                ExpressionAttributeValues=expression_values
            )
            
            items = response.get('Items', [])
            
            # startTime으로 정렬
            items.sort(key=lambda x: float(x.get('startTime', 0)))
            
            return items
            
        except Exception as e:
            print(f"❌ DynamoDB 조회 오류: {e}")
            return []
    
    def get_transcript_at_time(self, target_time, session_id=None, tolerance=1.0):
        """
        특정 시간의 transcript를 조회합니다.
        
        Args:
            target_time (float): 대상 시간 (초)
            session_id (str): 세션 ID (옵션)
            tolerance (float): 허용 오차 (초)
        
        Returns:
            dict: transcript 항목 또는 None
        """
        start_range = target_time - tolerance
        end_range = target_time + tolerance
        
        transcripts = self.get_transcript_by_time_range(start_range, end_range, session_id)
        
        # 가장 가까운 시간의 transcript 찾기
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
        
        # Transcript retriever 초기화
        try:
            self.transcript_retriever = TranscriptRetriever(DYNAMODB_TABLE_NAME, AWS_REGION)
            print(f"✅ DynamoDB 연결 성공: {DYNAMODB_TABLE_NAME}")
        except Exception as e:
            print(f"❌ DynamoDB 연결 실패: {e}")
            self.transcript_retriever = None
    
    def extract_discontinuity_sequence(self, manifest_content):
        """DISCONTINUITY-SEQUENCE 값을 추출합니다."""
        match = re.search(r'#EXT-X-DISCONTINUITY-SEQUENCE:(\d+)', manifest_content)
        return int(match.group(1)) if match else 0
    
    def extract_media_sequence(self, manifest_content):
        """MEDIA-SEQUENCE 값을 추출합니다."""
        match = re.search(r'#EXT-X-MEDIA-SEQUENCE:(\d+)', manifest_content)
        return int(match.group(1)) if match else 1
    
    def extract_segments(self, manifest_content):
        """매니페스트에서 세그먼트 목록을 추출합니다."""
        lines = manifest_content.strip().split('\n')
        segments = []
        
        for line in lines:
            if line.endswith('.ts'):
                segments.append(line.strip())
        
        return segments
    
    def find_first_segment_after_discontinuity(self, manifest_content):
        """DISCONTINUITY 후 첫 번째 세그먼트를 찾습니다."""
        lines = manifest_content.strip().split('\n')
        media_sequence = self.extract_media_sequence(manifest_content)
        
        # 우선순위 1: DISCONTINUITY 태그 직후
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
        
        # 우선순위 2: 매니페스트의 첫 번째 세그먼트
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
        """비디오 시작점을 탐지합니다."""
        # 조건 1: DISCONTINUITY-SEQUENCE 증가
        current_discontinuity = self.extract_discontinuity_sequence(manifest_content)
        discontinuity_increased = (
            self.previous_discontinuity_seq is not None and 
            current_discontinuity > self.previous_discontinuity_seq
        )
        
        # 조건 2: DISCONTINUITY 태그 존재
        has_discontinuity_tag = '#EXT-X-DISCONTINUITY' in manifest_content
        
        # 조건 3: MEDIA-SEQUENCE 리셋 패턴
        current_media_seq = self.extract_media_sequence(manifest_content)
        sequence_reset = (
            self.previous_media_sequence is not None and
            current_media_seq < self.previous_media_sequence
        )
        
        # 조건 4: 매니페스트 복구 (빈 상태에서 세그먼트 등장)
        segments = self.extract_segments(manifest_content)
        manifest_recovered = len(segments) > 0 and len(self.previous_segments) == 0
        
        # 최종 판단
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
        
        # 상태 업데이트
        self.previous_discontinuity_seq = current_discontinuity
        self.previous_media_sequence = current_media_seq
        self.previous_segments = segments
        
        return None
    
    def record_video_start(self, segment_info, detection_reasons):
        """비디오 시작점을 기록합니다."""
        timestamp = datetime.now()
        
        start_record = {
            'timestamp': timestamp,
            'segment': segment_info,
            'detection_reasons': detection_reasons,
            'confidence_score': self.calculate_confidence(detection_reasons)
        }
        
        self.video_start_points.append(start_record)
        
        # 실시간 알림
        print(f"\n🎬 새로운 영상 시작 감지! ({timestamp.strftime('%H:%M:%S')})")
        print(f"📁 첫 번째 세그먼트: {segment_info['filename']}")
        print(f"🔢 시퀀스 번호: #{segment_info['sequence']}")
        print(f"🎯 신뢰도: {segment_info['confidence']}")
        print(f"🔍 탐지 방법: {segment_info['method']}")
        print("=" * 60)
        
        return start_record
    
    def calculate_confidence(self, detection_reasons):
        """탐지 신뢰도를 계산합니다."""
        score = 0
        if detection_reasons['discontinuity_increased']: score += 40
        if detection_reasons['has_discontinuity_tag']: score += 30
        if detection_reasons['sequence_reset']: score += 20
        if detection_reasons['manifest_recovered']: score += 10
        return min(score, 100)
    
    def calculate_original_video_time(self, current_sequence):
        """현재 세그먼트의 원본 영상 시간을 계산합니다."""
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
        """세그먼트에 해당하는 transcript를 조회합니다."""
        if not self.transcript_retriever or not original_time:
            return None
        
        try:
            # 해당 시간 범위의 transcript 조회
            transcripts = self.transcript_retriever.get_transcript_by_time_range(
                original_time['start_time'], 
                original_time['end_time']
            )
            
            if transcripts:
                return transcripts
            
            # 정확한 시간이 없으면 가장 가까운 transcript 조회
            closest_transcript = self.transcript_retriever.get_transcript_at_time(
                original_time['start_time']
            )
            
            return [closest_transcript] if closest_transcript else []
            
        except Exception as e:
            print(f"❌ Transcript 조회 오류: {e}")
            return []

class HLSMonitor:
    def __init__(self, manifest_url, segment_duration=1):
        self.manifest_url = manifest_url
        self.segment_duration = segment_duration
        self.previous_segments = set()
        self.start_time = datetime.now()
        self.detector = OptimalFirstSegmentDetector()
        
    def fetch_manifest(self):
        """HLS 매니페스트를 가져옵니다."""
        try:
            response = requests.get(self.manifest_url, timeout=10)
            response.raise_for_status()
            return response.text
        except requests.RequestException as e:
            print(f"❌ 매니페스트 가져오기 실패: {e}")
            return None
    
    def parse_manifest(self, manifest_content):
        """매니페스트를 파싱하여 세그먼트 정보를 추출합니다."""
        if not manifest_content:
            return None
            
        lines = manifest_content.strip().split('\n')
        
        # EXT-X-MEDIA-SEQUENCE 찾기
        media_sequence = 1
        for line in lines:
            if line.startswith('#EXT-X-MEDIA-SEQUENCE:'):
                media_sequence = int(line.split(':')[1])
                break
        
        # 세그먼트 파일들 찾기
        segments = []
        segment_duration = self.segment_duration
        
        for i, line in enumerate(lines):
            # EXTINF 태그에서 세그먼트 길이 추출
            if line.startswith('#EXTINF:'):
                duration_match = re.search(r'#EXTINF:([0-9.]+)', line)
                if duration_match:
                    segment_duration = float(duration_match.group(1))
            
            # .ts 파일 찾기
            elif line.endswith('.ts'):
                segment_number = media_sequence + len(segments)
                segments.append({
                    'filename': line,
                    'number': segment_number,
                    'duration': segment_duration
                })
        
        # 라이브/VOD 상태 확인
        is_live = '#EXT-X-ENDLIST' not in manifest_content
        
        return {
            'media_sequence': media_sequence,
            'segments': segments,
            'is_live': is_live,
            'total_segments': len(segments),
            'manifest_content': manifest_content
        }
    
    def print_segment_info(self, parsed_data):
        """세그먼트 정보를 출력합니다."""
        if not parsed_data:
            return
        
        # 비디오 시작점 탐지
        video_start = self.detector.detect_video_start(parsed_data['manifest_content'])
        
        current_time = datetime.now().strftime("%H:%M:%S")
        status = "🔴 LIVE" if parsed_data['is_live'] else "⏹️ VOD"
        
        print(f"\n{'='*80}")
        print(f"⏰ {current_time} | {status} | 시작 시퀀스: {parsed_data['media_sequence']} | 총 세그먼트: {parsed_data['total_segments']}")
        print(f"{'='*80}")
        
        # 새로운 세그먼트만 표시
        current_segments = set()
        for segment in parsed_data['segments']:
            segment_key = f"{segment['number']}_{segment['filename']}"
            current_segments.add(segment_key)
            
            if segment_key not in self.previous_segments:
                # 원본 영상 시간 계산
                original_time = self.detector.calculate_original_video_time(segment['number'])
                
                print(f"🆕 {segment['filename']}")
                print(f"   📊 세그먼트 #{segment['number']:03d}")
                print(f"   📏 길이: {segment['duration']:.3f}초")
                
                if original_time:
                    start_fmt = str(timedelta(seconds=int(original_time['start_time'])))
                    end_fmt = str(timedelta(seconds=int(original_time['end_time'])))
                    print(f"   ⏱️  원본 영상 시간: {start_fmt} - {end_fmt} ({original_time['start_time']:.1f}s - {original_time['end_time']:.1f}s)")
                    
                    # DynamoDB에서 transcript 조회
                    transcripts = self.detector.get_transcript_for_segment(segment, original_time)
                    if transcripts:
                        print(f"   💬 Transcript ({len(transcripts)}개):")
                        for transcript in transcripts:
                            text = transcript.get('text', 'N/A')
                            start_time = float(transcript.get('startTime', 0))
                            end_time = float(transcript.get('endTime', 0))
                            print(f"      📝 [{start_time:.1f}s-{end_time:.1f}s] {text}")
                    else:
                        print(f"   💬 Transcript: 해당 시간대 자막 없음")
                else:
                    print(f"   ⏱️  원본 영상 시간: 시작점 미감지")
                
                print()
        
        self.previous_segments = current_segments
    
    def monitor(self, interval=5):
        """지정된 간격으로 매니페스트를 모니터링합니다."""
        print(f"🚀 HLS + Transcript 모니터링 시작")
        print(f"📡 URL: {self.manifest_url}")
        print(f"⏱️  모니터링 간격: {interval}초")
        print(f"📏 세그먼트 길이: {self.segment_duration}초")
        print(f"🗄️  DynamoDB 테이블: {DYNAMODB_TABLE_NAME}")
        print(f"🕐 시작 시간: {self.start_time.strftime('%Y-%m-%d %H:%M:%S')}")
        print("\n💡 Ctrl+C로 종료")
        
        try:
            while True:
                manifest_content = self.fetch_manifest()
                parsed_data = self.parse_manifest(manifest_content)
                self.print_segment_info(parsed_data)
                
                time.sleep(interval)
                
        except KeyboardInterrupt:
            print(f"\n\n🛑 모니터링 종료")
            elapsed = datetime.now() - self.start_time
            print(f"📊 총 실행 시간: {elapsed}")
            
            # 감지된 비디오 시작점들 요약
            if self.detector.video_start_points:
                print(f"\n📋 감지된 비디오 시작점들:")
                for i, start_point in enumerate(self.detector.video_start_points, 1):
                    print(f"   {i}. {start_point['timestamp'].strftime('%H:%M:%S')} - {start_point['segment']['filename']}")

def main():
    print("🎬 HLS 세그먼트 + Transcript 실시간 모니터링 도구")
    print("=" * 60)
    
    # 설정 변수 사용
    hls_url = MEDIAPACKAGE_HLS_URL
    segment_duration = SEGMENT_DURATION
    monitor_interval = MONITOR_INTERVAL
    
    # 사용자 입력으로 URL 변경 가능
    if len(sys.argv) > 1:
        hls_url = sys.argv[1]
        print(f"📝 사용자 지정 URL 사용: {hls_url}")
    else:
        print(f"📡 기본 URL 사용: MediaPackage 직접 URL")
    
    # 세그먼트 길이를 명령행 인수로 변경 가능
    if len(sys.argv) > 2:
        segment_duration = float(sys.argv[2])
        print(f"📏 사용자 지정 세그먼트 길이: {segment_duration}초")
    else:
        print(f"📏 기본 세그먼트 길이: {segment_duration}초")
    
    print(f"⏱️  모니터링 간격: {monitor_interval}초")
    print()
    
    monitor = HLSMonitor(hls_url, segment_duration)
    monitor.monitor(monitor_interval)

if __name__ == "__main__":
    main()
