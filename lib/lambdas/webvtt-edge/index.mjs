export const handler = async (event, context) => {
  const request = event.Records[0].cf.request;
  if (!request.body || !request.body.data) {
    return request;
  }
  const webvttContent = Buffer.from(request.body.data, 'base64').toString('utf-8');
  const lines = webvttContent.split('\n');
  lines.push('00:00:00.000 --> 23:59:59.999 line:13 position:5% align:left size:90%');
  const now = new Date();
  const timeStr = now.getHours().toString().padStart(2, '0') + ':' +
                  now.getMinutes().toString().padStart(2, '0') + ':' +
                  now.getSeconds().toString().padStart(2, '0') + ':' +
                  now.getMilliseconds().toString().padStart(3, '0');
  //lines.push(Date.now().toString() + ' ' + timeStr);
  lines.push(Date.now().toString());
  lines.push(timeStr);
  lines.push('');
  const modifiedContent = lines.join('\n');
  request.body.action = 'replace';
  request.body.data = Buffer.from(modifiedContent, 'utf-8').toString('base64');
  return request;
};