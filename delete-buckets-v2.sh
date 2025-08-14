#!/bin/bash

# 개선된 S3 버킷 삭제 스크립트
echo "🗑️  S3 버킷 삭제 시작..."

# 삭제할 버킷 목록 (전체)
buckets=(
    # BaseLiveStreamingStack 관련 버킷들
    "baselivestreamingstack-webvttdistributionloggingbu-sz9wvzfktqid"
    "baselivestreamingstack-distributionloggingbucketec-vv33fzv8ovrt"
    "baselivestreamingstack-webvttdistributionloggingbu-i0gq8gh4jpgl"
    "baselivestreamingstack-distributionloggingbucketec-lu9gi4trwgrj"
    "baselivestreamingstack-webvttdistributionloggingbu-ps4rievwpnyw"
    "baselivestreamingstack-distributionloggingbucketec-igspqcbsuofm"
    "baselivestreamingstack-webvttdistributionloggingbu-xnen6mxoepf2"
    "baselivestreamingstack-webvttdistributionloggingbu-0em3ovtoein2"
    "baselivestreamingstack-distributionloggingbucketec-hhohtjuwyy0d"
    "baselivestreamingstack-distributionloggingbucketec-ttw30gwjpq1s"
    "baselivestreamingstack-webvttdistributionloggingbu-y7vezxp1bkap"
    "baselivestreamingstack-distributionloggingbucketec-ekgaoki45uuz"
    "baselivestreamingstack-webvttdistributionloggingbu-9vxhsqaeavmz"
    "baselivestreamingstack-distributionloggingbucketec-d5c6uykvoyn3"
    "baselivestreamingstack-webvttdistributionloggingbu-xmdcpd3uktok"
    "baselivestreamingstack-distributionloggingbucketec-bikuslrccxyc"
    "baselivestreamingstack-webvttdistributionloggingbu-jrwoj988msr1"
    "baselivestreamingstack-distributionloggingbucketec-otepkhx2rfjk"
    "baselivestreamingstack-webvttdistributionloggingbu-97yddbxq7dpb"
    "baselivestreamingstack-distributionloggingbucketec-hlzfnxjx36cv"
    "baselivestreamingstack-webvttdistributionloggingbu-itb48dff6gq2"
    "baselivestreamingstack-distributionloggingbucketec-1whlji5hytin"
    "baselivestreamingstack-webvttdistributionloggingbu-m6lokproyjap"
    "baselivestreamingstack-distributionloggingbucketec-284pv5aksfgl"
    "baselivestreamingstack-webvttdistributionloggingbu-harm0wyhvgvr"
    "baselivestreamingstack-distributionloggingbucketec-hrzw7eeagpzp"
    "baselivestreamingstack-webvttdistributionloggingbu-zzwvjywzqabf"
    "baselivestreamingstack-distributionloggingbucketec-n0n3ezwgu6zv"
    "baselivestreamingstack-webvttdistributionloggingbu-mynmhya8pbpl"
    "baselivestreamingstack-distributionloggingbucketec-mjhi17nhvnow"
    "baselivestreamingstack-webvttdistributionloggingbu-4rdwgvbopwsr"
    "baselivestreamingstack-distributionloggingbucketec-rpbfmfc2syze"
    "baselivestreamingstack-webvttdistributionloggingbu-wllsm40jax4f"
    "baselivestreamingstack-distributionloggingbucketec-deeyzgfakgye"
    "baselivestreamingstack-webvttdistributionloggingbu-kcg3kifdmrvh"
    "baselivestreamingstack-distributionloggingbucketec-5zyuf4pdrxkf"
    "baselivestreamingstack-webvttdistributionloggingbu-zlo3jultl2o1"
    "baselivestreamingstack-distributionloggingbucketec-l8u0mxmssb1e"
    "baselivestreamingstack-webvttdistributionloggingbu-lrh60xxvbrhl"
    "baselivestreamingstack-webvttdistributionloggingbu-an8jyt0ish5c"
    "baselivestreamingstack-distributionloggingbucketec-lfm52vnx2vc6"
    "baselivestreamingstack-distributionloggingbucketec-5uagzycmn1la"
    "baselivestreamingstack-webvttdistributionloggingbu-rxhdxdldpytr"
    "baselivestreamingstack-distributionloggingbucketec-amt7w6mdqqiv"
    "baselivestreamingstack-webvttdistributionloggingbu-xmyxwkcwl10e"
    "baselivestreamingstack-distributionloggingbucketec-6rudriudlib5"
    "baselivestreamingstack-webvttdistributionloggingbu-dorqmcclqzat"
    "baselivestreamingstack-distributionloggingbucketec-k8xuku42jitn"
    "baselivestreamingstack-webvttdistributionloggingbu-djd0ph8bowb7"
    "baselivestreamingstack-distributionloggingbucketec-w0oil4rzipj2"
    "baselivestreamingstack-webvttdistributionloggingbu-pc2lwmm2gaxj"
    "baselivestreamingstack-distributionloggingbucketec-v1lyrdpd2l2c"
    "baselivestreamingstack-webvttdistributionloggingbu-v5euyxavuccb"
    "baselivestreamingstack-distributionloggingbucketec-s82cqrkxxvg5"
    "baselivestreamingstack-webvttdistributionloggingbu-jtgxvq1dpomk"
    "baselivestreamingstack-distributionloggingbucketec-ycvaqqsdrikf"
    "baselivestreamingstack-webvttdistributionloggingbu-u2i0anhab42j"
    "baselivestreamingstack-distributionloggingbucketec-rqgt9bamg1hz"
    "baselivestreamingstack-webvttdistributionloggingbu-8wkrmddarcnu"
    "baselivestreamingstack-distributionloggingbucketec-qms5zi1xlezg"
    "baselivestreamingstack-webvttdistributionloggingbu-rntc7z2yoedy"
    "baselivestreamingstack-distributionloggingbucketec-712vzi2toieo"
    "baselivestreamingstack-webvttdistributionloggingbu-z5kladouqwzz"
    
    # 기타 버킷들
    "cleanrooms-taehoon-secondaccount"
    "data-workshop-972965166970"
    "mediatailor-demo-972965166970-us-west-2"
    "custom-labels-console-us-east-2-da6ddd28e9"
    "sagemaker-studio-fwie45jdu09"
    "aws-mre-shared-resources-lambdalayerbucket3217ab2-1fphaz1x5o668"
    "aws-mre-shared-resources-mremediaoutputbucket4789-l2i3lestffdr"
    "aws-mre-shared-resources-mremediasourcebucketcd0d-quv1hlkutj78"
    "aws-mre-shared-resources-mresegmentcachebucket67c-kg507iz8znw8"
    "aws-mre-shared-resources-mretransitionsclipbucket-8hlefk5oeh2p"
    "aws-mre-shared-resources-mreaccesslogsbucket423e9-ysc40qh6zhqx"
    "aws-mre-shared-resources-mredataexportbucketff87b-1b0jn4nthc3jw"
)

# 성공/실패 카운터
success_count=0
failed_count=0
failed_buckets=()

echo "📊 총 ${#buckets[@]}개 버킷 삭제 예정"
echo ""

# 각 버킷 삭제
for bucket in "${buckets[@]}"; do
    echo "🔍 처리 중: $bucket"
    
    # 1. 버킷 존재 확인
    if aws s3api head-bucket --bucket "$bucket" >/dev/null 2>&1; then
        echo "   ✅ 버킷 존재 확인"
        
        # 2. 버킷 내용 확인
        object_count=$(aws s3 ls "s3://$bucket" --recursive 2>/dev/null | wc -l)
        echo "   📁 객체 수: $object_count"
        
        # 3. 버킷 비우기
        if [ "$object_count" -gt 0 ]; then
            echo "   🧹 버킷 비우는 중..."
            aws s3 rm "s3://$bucket" --recursive >/dev/null 2>&1
        fi
        
        # 4. 버킷 삭제
        echo "   🗑️  버킷 삭제 중..."
        if aws s3api delete-bucket --bucket "$bucket" >/dev/null 2>&1; then
            echo "   ✅ 성공: $bucket"
            ((success_count++))
        else
            echo "   ❌ 삭제 실패: $bucket"
            ((failed_count++))
            failed_buckets+=("$bucket")
        fi
    else
        echo "   ⚠️  버킷이 존재하지 않거나 접근 불가: $bucket"
    fi
    
    echo ""
    # API 제한 방지를 위한 짧은 대기
    sleep 0.3
done

echo "📊 삭제 결과:"
echo "✅ 성공: $success_count 개"
echo "❌ 실패: $failed_count 개"
echo "⚠️  존재하지 않음: $((${#buckets[@]} - success_count - failed_count)) 개"

if [ $failed_count -gt 0 ]; then
    echo ""
    echo "❌ 실패한 버킷들:"
    for failed_bucket in "${failed_buckets[@]}"; do
        echo "   - $failed_bucket"
    done
fi

echo ""
echo "🎯 완료!"
