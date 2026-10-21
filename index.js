import parsePrometheusTextFormat from 'parse-prometheus-text-format';
import fetch from 'node-fetch';
import Express from 'express';

const KUMA_KEY=process.env.KUMA_KEY;
if(!KUMA_KEY){
    throw new Error('KUMA_KEY must be configured');
}
const KUMA_METRICS=process.env.KUMA_METRICS||'http://uptime:3001/metrics';
const KUMA_METRICS_UPDATE_FREQUENCY=parseInt(process.env.KUMA_METRICS_UPDATE_FREQUENCY||1000*60,10);
const KUMA_METRICS_MERGER_PORT=parseInt(process.env.KUMA_METRICS_MERGER_PORT||3002);

const metricsDataCache={
    cache: null,
    lastUpdate: 0,
    pending: null,
};

async function getMetrics(){
    if(metricsDataCache.cache && Date.now()-metricsDataCache.lastUpdate<KUMA_METRICS_UPDATE_FREQUENCY){
        return metricsDataCache.cache;
    }

    if(metricsDataCache.pending)return metricsDataCache.pending;
    metricsDataCache.pending=fetch(KUMA_METRICS, {
        headers: {
            Authorization: `Basic `+Buffer.from(`:${KUMA_KEY}`).toString('base64')
        },
        signal: AbortSignal.timeout(10_000),
        size: 5*1024*1024
    }).then(async metrics=>{
        if(!metrics.ok)throw new Error(`Metrics endpoint returned ${metrics.status}`);
        const metricsData=parsePrometheusTextFormat(await metrics.text());
        metricsDataCache.cache=metricsData;
        metricsDataCache.lastUpdate=Date.now();
        return metricsData;
    }).finally(()=>{metricsDataCache.pending=null;});
    return metricsDataCache.pending;
}

async function getMetricValue(name,metricName,fallback){
    try{
        if(typeof name!=='string'||name.length>256||!name.match(/^[a-zA-Z0-9\-\_\.\s]+$/)){
            throw new Error('Invalid monitor name');
        }
        const metricsData=await getMetrics();
        const metric=metricsData.find(entry=>entry.name===metricName)?.metrics?.find(entry=>entry.labels?.monitor_name===name);
        const value=Number.parseInt(metric?.value,10);
        return Number.isFinite(value)?value:fallback;
    }catch(e){
        console.log(e);
        return fallback;
    }
}

async function getMetric(name){
    return getMetricValue(name,'monitor_status',0);
}

async function getMetricResponseTime(name){
    return getMetricValue(name,'monitor_response_time',-1);
}

async function getMergeMetrics(names,timeout=0){
    let v=1;
    for(const name of names){
        let metric=await getMetric(name,timeout);
        if(!metric){
            v=0;
            break;
        }
        if(metric==1&&timeout>0){
            const responseTime=await getMetricResponseTime(name);
            if(responseTime==-1||responseTime>timeout){
                v=0;
                break;
            }
        }
        if(metric===0){
            v=0;
            break;
        }
    }
    return v;
}

const app=Express();
app.use(Express.json());

app.post('/', async (req, res)=>{
    const contentType=req.headers['content-type'];
    if(contentType!=='application/json'){
        res.status(400).json({error: 'Invalid content type'});
        return;
    }
    const monitors=req.body.monitors;
    if(!Array.isArray(monitors)||monitors.length===0||monitors.length>64||monitors.some(name=>typeof name!=='string'||name.length>256)){
        res.status(400).json({error: 'Invalid monitors'});
        return;
    }
    const plainOutput=req.body.plainOutput;
    const apiKey=req.body.apiKey;
    const timeout=Number(req.body.timeout||0);
    if(apiKey!==KUMA_KEY){
        res.status(401).json({error: 'Invalid API key'});
        return;
    }
    if(!Number.isSafeInteger(timeout)||timeout<0||timeout>3_600_000){
        res.status(400).json({error: 'Invalid timeout'});
        return;
    }
    const v=await getMergeMetrics(monitors,timeout);
    if(plainOutput){
        res.send(v==1?"OK":"DOWN");
    }else{
        res.json({"result": v});
    }
});

app.listen(KUMA_METRICS_MERGER_PORT, ()=>{
    console.log("Listening on port "+KUMA_METRICS_MERGER_PORT);
});
