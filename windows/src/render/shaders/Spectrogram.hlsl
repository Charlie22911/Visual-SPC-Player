Texture2D<float2> RawSpectrum : register(t0);
struct Column { uint low, high; float fraction,lowWeight; };
StructuredBuffer<Column> Columns : register(t1);
struct Projection { uint4 header; uint4 slots[3]; float4 weights[3]; };
StructuredBuffer<Projection> Projects : register(t2);
RWTexture2D<float> ProjectedOutput : register(u0);
Texture2D<float> ProjectedSpectrum : register(t3);
struct TimeRow { uint slot,count,next,valid; float phase,lowWeight; float2 unused; };
StructuredBuffer<TimeRow> Times : register(t4);
Texture2D<float4> SpectrumPalette : register(t5);
cbuffer SpectrumConstants : register(b0) {
    uint width,height,capacity,sampling;
    uint difference,jobCount,unusedA,unusedB;
    float floorDb,ceilingDb,unusedC,unusedD;
};
[numthreads(32,1,1)]
void SpectrumProjectCS(uint3 id : SV_DispatchThreadID) {
    if(id.x>=width || id.y>=jobCount) return;
    Projection job=Projects[id.y]; Column col=Columns[id.x]; float value=0;
    [loop] for(uint tap=0;tap<job.header.y;++tap) {
        uint slot=job.slots[tap/4][tap%4]; float weight=job.weights[tap/4][tap%4];
        float power=0;
        if(sampling==1 && col.high-col.low==2) {
            float2 a=RawSpectrum.Load(int3(col.low,slot,0)),b=RawSpectrum.Load(int3(col.low+1,slot,0));
            power=(difference? a.y:a.x)*col.lowWeight+(difference? b.y:b.x)*col.fraction;
        } else {
            [loop] for(uint bin=col.low;bin<col.high;++bin) {
                float2 p=RawSpectrum.Load(int3(bin,slot,0)); power+=difference?p.y:p.x;
            }
            power/=max(1u,col.high-col.low);
        }
        value+=power*weight;
    }
    ProjectedOutput[uint2(id.x,job.header.x)]=value;
}
float4 SpectrumDisplayPS(float4 position : SV_POSITION) : SV_TARGET {
    uint2 p=(uint2)position.xy; TimeRow row=Times[p.y];
    if(!row.valid) return float4(2.0/255,5.0/255,12.0/255,1);
    float power=0;
    [loop] for(uint i=0;i<row.count;++i) power+=ProjectedSpectrum.Load(int3(p.x,(row.slot+i)%capacity,0));
    power/=max(1u,row.count);
    if(row.phase>0) power=power*row.lowWeight+ProjectedSpectrum.Load(int3(p.x,row.next,0))*row.phase;
    float db=3.01029995664*log2(max(1e-12,power));
    uint level=(uint)(saturate((db-floorDb)/max(1.0,ceilingDb-floorDb))*255);
    return SpectrumPalette.Load(int3(level,0,0));
}
