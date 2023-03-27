import parsePrometheusTextFormat from 'parse-prometheus-text-format';
import fetch from 'node-fetch';
import jp from "jsonpath";
import Express from 'express';

const KUMA_KEY=process.env.KUMA_KEY;
const KUMA_METRICS=process.env.KUMA_METRICS||'http://kuma.docker:3001/metrics';
const KUMA_METRICS_UPDATE_FREQUENCY=parseInt(process.env.KUMA_METRICS_UPDATE_FREQUENCY||1000*60);
const KUMA_METRICS_MERGER_PORT=parseInt(process.env.KUMA_METRICS_MERGER_PORT||3002);

const metricsDataCache={
    cache: null,
    lastUpdate: 0,
};

async function getMetrics(){
    if(metricsDataCache.cache && Date.now()-metricsDataCache.lastUpdate<KUMA_METRICS_UPDATE_FREQUENCY){
        return metricsDataCache.cache;
    }

    const metrics=await fetch(KUMA_METRICS, {
        headers: {
            Authorization: `Basic `+Buffer.from(`:${KUMA_KEY}`).toString('base64')
        }
    });

    const metricsText=await metrics.text();
    const metricsData = parsePrometheusTextFormat( metricsText);
    metricsDataCache.cache=metricsData;
    metricsDataCache.lastUpdate=Date.now();
    return metricsData;
}

async function getMetric(name){
    try{
        if(!name.match(/^[a-zA-Z0-9\-\_\.\s]+$/)){
            throw new Error('Invalid monitor name');
        }
        const metricsData=await getMetrics();
        const jsonPath=`$[?(@.name == 'monitor_status')].metrics[?(@.labels.monitor_name == '${name}')].value`;
        const metric=jp.query(metricsData, jsonPath);
        const v=parseInt(metric[0]);
        return v;
    }catch(e){
        console.log(e);
        return 0;
    }
}


async function getMetricResponseTime(name){
    try{
        if(!name.match(/^[a-zA-Z0-9\-\_\.\s]+$/)){
            throw new Error('Invalid monitor name');
        }
        const metricsData=await getMetrics();
        const jsonPath=`$[?(@.name == 'monitor_response_time')].metrics[?(@.labels.monitor_name == '${name}')].value`;
        const metric=jp.query(metricsData, jsonPath);
        const v=parseInt(metric[0]);
        return v;
    }catch(e){
        console.log(e);
        return -1;
    }
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
    if(!monitors || !Array.isArray(monitors)||monitors.length===0){
        res.status(400).json({error: 'Invalid monitors'});
    }
    const plainOutput=req.body.plainOutput;
    const apiKey=req.body.apiKey;
    const timeout=parseInt(req.body.timeout||0);
    if(apiKey!==KUMA_KEY){
        res.status(401).json({error: 'Invalid API key'});
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