let METADATA_API_URL, MEDIATAILOR_URL, DISTRIBUTION_ORIGIN_URL, LOGIN_URL

const parseVideoList = function(videoList){
    var playlist = []
    for (let i = 0; i < videoList.length; i++) {
        var videoListItem = videoList[i]; 
        // only show videos that are fully transcoded and longer than 3 minutes
        if (videoListItem.duration && (videoListItem.duration >= (3*60*1000))) {
            var videoOriginPath = videoListItem.id + '/' + videoListItem.title + '.m3u8' + '?ads.aid=' + videoListItem.id;
            var thumbnailOriginPath = videoListItem.id + '/thumbnail.jpg';
            playlist.push({
                sources: [{
                    src: MEDIATAILOR_URL + videoOriginPath,
                    type: 'application/x-mpegURL'
                }],
                poster: DISTRIBUTION_ORIGIN_URL + thumbnailOriginPath,
                duration: videoListItem.duration / 1000,
                markers: JSON.parse(videoListItem.markers),
                name: videoListItem.title,
                description: "",
                aid: videoListItem.id,
                thumbnail: [
                        {
                        src: DISTRIBUTION_ORIGIN_URL + thumbnailOriginPath    
                        }
                    ]
            })
        }
    }
    console.log('playlist: ', playlist);
    return playlist;
}

const buildMarkers = function(item) {
    // split ad markers and open/end credits markers
    ad_markers = [];
    credit_markers = [];
    // CSAI get ad markers from metadata api
    for(var i=0;i<item.markers.length;i++){
            var marker = item.markers[i];
            if (marker.time) {
                if (marker.type == "adbreak"){
                    ad_markers.push({time: marker.time / 1000, label: 'Ad Break #' + (ad_markers.length + 1), duration: 0.5})
                } else if (marker.type == "endCredit") {
                    credit_markers.push({time: marker.time / 1000, label: 'End Credits', duration: 0.5})
                }
            }
        }
        console.log("ad markers:", ad_markers);
        drawMarkersOnPlayerTimeline(ad_markers, item.duration);
        //drawMarkersOnTable(ad_markers);
        console.log("open/end credits markers:", credit_markers);
        drawMarkersOnPlayerTimeline(credit_markers, item.duration);
        //drawMarkersOnTable(credit_markers);
}       

const drawMarkersOnPlayerTimeline = function(markers, total) {
        var player_timeline = player.controlBar.progressControl.children_[0].el_;
        for(var i=0;i<markers.length;i++){
            var time = markers[i].time;
            var left = (time / total * 100)+'%';
            var template = document.createElement('template');
            template.innerHTML = '<div class="vjs-marker" style="left:'+left+'" data-time="'+time+'"><span>'+markers[i].label+'</span></div>';
            var marker = template.content.firstChild;
            /*ad_marker.click(function(){
                console.log('clicked', this.data('time'));
                //player.currentTime($(this).data('time')); 
            });*/                             
            player_timeline.append(marker);                        
        }
}

const drawMarkersOnTable = function(markers) {
    const markers_table = document.getElementById("markers-table");
    for(var i=0;i<markers.length;i++){
        const marker = markers[i];
        const row = document.createElement("tr");
        const cel1 = row.insertCell(0);
        cel1.appendChild(document.createTextNode(markers_table.rows.length+1));
        const cel2 = row.insertCell(1);
        cel2.appendChild(document.createTextNode(marker.label));
        const cel3 = row.insertCell(2);
        cel3.appendChild(document.createTextNode(marker.time * 1000));
        markers_table.append(row);
    }
}

const getAdMarkerFromCurrentTime = function(currentTime) {
    const ad_notice_period = 10;
    var ad_marker;
    for(var i=0;i<ad_markers.length;i++){
        if ((currentTime > ad_markers[i].time - ad_notice_period) && (currentTime < (ad_markers[i].time))){
            ad_marker = ad_markers[i];
            ad_marker.ad_notice_period = true;
        } else if ((currentTime > ad_markers[i].time) && (currentTime < (ad_markers[i].time + ad_markers[i].duration))) {
            ad_marker = ad_markers[i];
            ad_marker.ad_notice_period = false;
        }
    }
    return ad_marker
}

const fadePlayerOut = function () {
    var op = parseFloat(player.children_[0].style.opacity);
    if (!timer_fadePlayerOut && !timer_fadePlayerIn) {
        //console.log('fadePlayerOut')
        timer_fadePlayerOut = setInterval(function() {
        if (op >= 0.1) {
            op = parseFloat((op - 0.1).toFixed(1));
            player.children_[0].style.opacity = Math.max(op,0);
            player.children_[0].volume = Math.max(op,0);
            //console.log(op);
        } else {
            clearInterval(timer_fadePlayerOut)
            timer_fadePlayerOut = 0;
        }
        }, 100);
    }          
}
const fadePlayerIn = function () {
    var op = parseFloat(player.children_[0].style.opacity);
    if (!timer_fadePlayerIn && !timer_fadePlayerOut) {
        //console.log('fadePlayerIn')
        timer_fadePlayerIn = setInterval(function() {
        if (op <= 0.9) {
            op = parseFloat((op + 0.1).toFixed(1));
            if (op >= 0.5) {
                player.children_[0].style.opacity = Math.min(op,1);
                player.children_[0].volume = Math.min(op,1);  
                //console.log(op);
            }      
        } else {
            clearInterval(timer_fadePlayerIn);
            timer_fadePlayerIn = 0;
        }
        }, 200);
    }
}

const handleAdUi = function() {
    if (ad_markers.length > 0) {
        var currentTime = player.currentTime();
        current_ad_marker = getAdMarkerFromCurrentTime(currentTime);
        if (current_ad_marker && current_ad_marker.ad_notice_period) {
            // ad notice period (still in content but x seconds before ad break)
            //console.log('// ad notice period');
            var time_to_ad_marker = current_ad_marker.time - currentTime + 1;
            if (time_to_ad_marker <= 2.5) {
                fadePlayerOut();
            }
            player.controlBar.show();
            player.titleBar.show();
            skip_ads_button.style.visibility = 'hidden';
            player.titleBar.els.title.innerText = 
                'Ad starting in ' + parseInt(time_to_ad_marker) + ' seconds...';
        } else if (current_ad_marker) {
            // ad break
            //console.log('// ad break');
            player.pause();
            var time_to_content = 
            //var time_to_content = (current_ad_marker.time + current_ad_marker.duration) - currentTime + 1;
            /*if (current_ad_marker.duration - time_to_content <= 2) {
                fadePlayerIn();
            } else if (time_to_content <= 2.5){
                fadePlayerOut();
            }*/
            player.controlBar.hide();
            player.titleBar.show();
            player.titleBar.els.title.innerText = 
                'Your video will resume in ' + parseInt(time_to_content) + ' seconds...';
            skip_ads_button.style.visibility = 'visible';
        } 
        else { 
            // normal content
            //console.log('// normal content');
            fadePlayerIn();
            player.controlBar.show();
            player.titleBar.hide();
            skip_ads_button.style.visibility = 'hidden';
        }
    }  
    // handle end credits UI
    if (credit_markers.length > 0) {   
        if (player.currentTime() > credit_markers[0].time){
            //console.log('// end credit');
            player.titleBar.show();
            //skip_ads_button.style.visibility = 'hidden';
            player.titleBar.els.title.innerText = 
                'Next episode starting in ' + parseInt(player.duration() - player.currentTime()) + ' seconds...';    
        } 
    }   
}

const skipAds = function() {
    player.currentTime(current_ad_marker.time + current_ad_marker.duration);
    player.play()
}

const validate = function() {
    //open accurate video player in new browser tab
    player.pause()
    window.open(
        'https://apps.accurate.video/launch/validate?launchTemplate=https://qsm48v05de.execute-api.us-east-1.amazonaws.com/prod/launchTemplates/' + current_item.aid + '&frame=100', 
        "_blank");
}

const handlePlaylistitemSelected = function(object, item) {
        current_item = item;
        window.scrollTo(0,0);
        player.play();
        //purge existing markers
        const marker_elements = document.getElementsByClassName("vjs-marker");
        while(marker_elements.length > 0){
            marker_elements[0].parentNode.removeChild(marker_elements[0]);
        }
        //purge existing markers in table
        //const markers_table = document.getElementById("markers-table");
        //markers_table.innerHTML = '';
        //reset player fadings
        clearInterval(timer_fadePlayerIn);
        timer_fadePlayerIn = 0;
        clearInterval(timer_fadePlayerOut);
        timer_fadePlayerOut = 0;
        //CSAI build new markers
        buildMarkers(item);
        //Show validate button at the bottom of the player
        validate_button.style.visibility = 'visible';


}

/////////// START ENTRY POINT MAIN APPLICATION ////////////////////////////
///////////////////////////////////////////////////////////////////////////

var player = videojs('my-video');
var skip_ads_button = document.getElementById('skip-ads-button');
skip_ads_button.addEventListener('click', skipAds);
var validate_button = document.getElementById('validate-button');
validate_button.addEventListener('click', validate);
var ad_markers = [];
var credit_markers = [];
var current_ad_marker = [];
var current_item = {};
var timer_fadePlayerIn, timer_fadePlayerOut;
localStorage.setItem('id_token', new URLSearchParams(window.location.hash).get('id_token'));

// load config.json
fetch('./config.json').then(response => response.json()).then(json => {
    METADATA_API_URL = json.MetadataApiStack.metadataapiurl;  
    //MEDIATAILOR_URL = json.AdBreakProcessingStack.mediatailorurl;
    //CSAI -> skip mediatailor!!!
    MEDIATAILOR_URL = json.AdBreakProcessingStack.CDNdistribtionoriginvideosurl;
    DISTRIBUTION_ORIGIN_URL = json.AdBreakProcessingStack.CDNdistribtionoriginvideosurl;
    LOGIN_URL = json.CognitoStack.loginurl;
    // load playlist from Metadata Service API
    fetch(METADATA_API_URL + 'videos', {headers: {'Authorization': localStorage.getItem('id_token')}}).then(response => response.json()).then(json => {
        // start populating playlist UI
        var playlist = parseVideoList(json);
        player.playlist(playlist, -1);
        // Play through the playlist automatically.
        player.playlist.autoadvance(1);
        player.playlistUi({horizontal: false});
        //player.on("loadedmetadata",buildMarkers);
        player.on("timeupdate", handleAdUi);
        player.on('playlistitem', handlePlaylistitemSelected);
        player.children_[0].style.opacity = 1;
    }).catch(error => {
        //go to cognito hosted login UI with this page as redirect back url, if error response is 401 unauthorized
        const cognito_hosted_UI = LOGIN_URL + window.location.href
        console.log(cognito_hosted_UI);
        window.location.href = cognito_hosted_UI;
    })
})

