Texture2D<uint> CurrentRam : register(t0);
Buffer<uint> AccessWords : register(t1);
Texture2D<uint> PreviousRam : register(t2);
Buffer<float> Entropy : register(t3);
Texture2D<float4> Palette : register(t4);
Texture2D<uint> Persistence : register(t5);
Texture2D<float2> Rows : register(t6);
Texture2D<uint> RowFlags : register(t7);
Texture2D<float4> Image : register(t8);
cbuffer Config : register(b0) {
    uint mode, bits, changes, underlay;
    uint palette, previousValid, persistent, ringHeight;
    uint newestSlot, renderWidth, unused0, unused1;
};
float4 FullscreenVS(uint id : SV_VertexID) : SV_POSITION {
    float2 uv = float2((id << 1) & 2, id & 2);
    return float4(uv * float2(2, -2) + float2(-1, 1), 0, 1);
}
float4 BlitPS(float4 position : SV_POSITION) : SV_TARGET {
    uint2 source = (uint2)(position.xy * float2(bits ? 1024 : 256, bits ? 512 : 256) / float2(renderWidth, ringHeight));
    return Image.Load(int3(source, 0));
}
float4 color(uint table, uint value) { return Palette.Load(int3(min(value, 255), palette * 4 + table, 0)); }
uint accessAt(uint a) {
    uint word = a >> 5, shift = a & 31;
    return ((AccessWords[word] >> shift) & 1) |
        (((AccessWords[2048 + word] >> shift) & 1) << 1) |
        (((AccessWords[4096 + word] >> shift) & 1) << 2);
}
float4 activityColor(uint kind, float value) {
    float4 foreground = color(3, kind);
    if (!underlay) return foreground;
    uint index = bits ? (uint)floor(saturate(value) * 255 + 0.5) : (uint)floor(clamp(value, 0, 255) + 0.5);
    float3 background = color(bits ? 1 : 0, index).rgb;
    float3 blended = background * 0.35 * (kind ? 0.08 : 1) + (kind ? foreground.rgb * 0.92 : 0);
    return float4(floor(blended * 255 + 0.5) / 255, 1);
}
float4 MapPS(float4 position : SV_POSITION) : SV_TARGET {
    uint2 p = (uint2)position.xy;
    uint a = bits ? ((p.y >> 1) * 256 + (p.x >> 2)) : p.y * 256 + p.x;
    uint lane = bits ? ((p.y & 1) * 4 + (p.x & 3)) : 0;
    uint value = CurrentRam.Load(int3(a & 255, a >> 8, 0));
    uint held = Persistence.Load(int3(a & 255, a >> 8, 0));
    if (mode == 0) {
        uint kind = persistent && !underlay ? held : accessAt(a);
        return activityColor(kind, bits ? ((value >> (7 - lane)) & 1) : value);
    }
    if (mode == 2) return color(2, (uint)floor(saturate(Entropy[lane * 256 + (a >> 8)] / (bits ? 1 : 8)) * 255 + 0.5));
    if (changes && !previousValid) return color(2, a & 8 ? 20 : 35);
    if (changes) value ^= PreviousRam.Load(int3(a & 255, a >> 8, 0));
    float4 result = color(bits ? 1 : 0, bits ? ((value >> (7 - lane)) & 1) * 255 : value);
    if (persistent && !changes && held) result.rgb = result.rgb * 0.55 + color(3, held).rgb * 0.45;
    return result;
}
float4 WaterfallPS(float4 position : SV_POSITION) : SV_TARGET {
    uint2 p = (uint2)position.xy;
    uint y = (newestSlot + ringHeight - p.y) % ringHeight;
    uint flags = RowFlags.Load(int3(p.x, y, 0));
    if (!(flags & 1)) return float4(16.0 / 255, 23.0 / 255, 34.0 / 255, 1);
    float2 data = Rows.Load(int3(p.x, y, 0));
    if (mode == 0) return activityColor((uint)data.x, data.y);
    if (mode == 2) return color(2, (uint)floor(saturate(data.x / (bits ? 1 : 8)) * 255 + 0.5));
    uint index = bits ? (uint)floor(saturate(data.x) * 255 + 0.5) : (uint)floor(clamp(data.x, 0, 255) + 0.5);
    if (changes && (flags & 2)) index = max(1, index);
    if (bits && data.x > 0) index = max(1, index);
    return color(bits ? 1 : 0, index);
}

// Physical plot pixels. Numeric reduction occurs before palette lookup.
cbuffer MapPresentation : register(b1) { float2 mapOrigin; float cellSize; float cellSizeY; };
float4 AreaPS(float4 position : SV_POSITION) : SV_TARGET {
    float2 dimensions = float2(bits ? 1024 : 256, bits ? 512 : 256);
    float2 lo = max(0, (floor(position.xy) - mapOrigin) / float2(cellSize, cellSizeY));
    float2 hi = min(dimensions, (floor(position.xy) + 1 - mapOrigin) / float2(cellSize, cellSizeY));
    float4 background = float4(2,5,12,255) / 255;
    if (any(hi <= lo)) return background;
    float total = 0, weight = 0;
    uint kinds = 0, heldKinds = 0;
    bool changed = false;
    [loop] for (int y = (int)floor(lo.y); y < (int)ceil(hi.y); ++y) {
        float wy = max(0, min(hi.y, y + 1.0) - max(lo.y, (float)y));
        [loop] for (int x = (int)floor(lo.x); x < (int)ceil(hi.x); ++x) {
            float w = wy * max(0, min(hi.x, x + 1.0) - max(lo.x, (float)x));
            if (w <= 0) continue;
            uint2 p = uint2(x,y);
            uint a = bits ? ((p.y >> 1) * 256 + (p.x >> 2)) : p.y * 256 + p.x;
            uint lane = bits ? ((p.y & 1) * 4 + (p.x & 3)) : 0;
            uint value = CurrentRam.Load(int3(a & 255, a >> 8, 0));
            if (changes) value ^= PreviousRam.Load(int3(a & 255, a >> 8, 0));
            if (bits) value = (value >> (7-lane)) & 1;
            total += w * (mode == 2 ? Entropy[lane * 256 + (a >> 8)] : (float)value);
            weight += w; changed = changed || value != 0;
            if (mode == 0 && !(persistent && !underlay)) kinds |= accessAt(a);
            if (persistent && ((mode == 0 && !underlay) || (mode == 1 && !changes))) heldKinds |= Persistence.Load(int3(a & 255, a >> 8, 0));
        }
    }
    float mean = total / weight;
    float4 result;
    if (mode == 0) result = activityColor(persistent && !underlay ? heldKinds : kinds, mean);
    else if (mode == 2) result = color(2, (uint)floor(saturate(mean / (bits ? 1 : 8)) * 255 + 0.5));
    else if (changes && !previousValid) result = color(2, ((uint)floor(position.x) & 8) ? 20 : 35);
    else {
        uint index = (uint)floor(clamp(mean * (bits ? 255 : 1), 0, 255) + 0.50001);
        if (changes && changed) index = max(1, index);
        result = color(bits ? 1 : 0, index);
        if (persistent && !changes && heldKinds) result.rgb = result.rgb * 0.55 + color(3, heldKinds).rgb * 0.45;
    }
    float coverage = saturate((hi.x-lo.x)*(hi.y-lo.y)*cellSize*cellSizeY);
    return lerp(background, result, coverage);
}

// Resample chronological numeric bands, never interpolate physical ring slots.
float4 WaterfallAreaPS(float4 position : SV_POSITION) : SV_TARGET {
    float2 ratio = float2(renderWidth, ringHeight) / float2(unused0, unused1);
    float2 lo = floor(position.xy) * ratio;
    float2 hi = min(float2(renderWidth,ringHeight), (floor(position.xy)+1)*ratio);
    // Enlargement remains nearest independently on each axis.
    if (ratio.x <= 1) { lo.x = floor((position.x)*ratio.x); hi.x = lo.x+1; }
    if (ratio.y <= 1) { lo.y = floor((position.y)*ratio.y); hi.y = lo.y+1; }
    float total=0, background=0, validWeight=0;
    uint kinds=0; bool changed=false;
    [loop] for(int y=(int)floor(lo.y);y<(int)ceil(hi.y);++y) {
        float wy=max(0,min(hi.y,y+1.0)-max(lo.y,(float)y));
        uint slot=(newestSlot+ringHeight-(uint)y)%ringHeight;
        [loop] for(int x=(int)floor(lo.x);x<(int)ceil(hi.x);++x) {
            float w=wy*max(0,min(hi.x,x+1.0)-max(lo.x,(float)x));
            if(w<=0) continue;
            uint flags=RowFlags.Load(int3(x,slot,0));
            if(!(flags&1)) continue;
            float2 data=Rows.Load(int3(x,slot,0));
            if(previousValid) {
                // Time-based causal triangular low-pass, bounded to eight taps.
                float2 sum=data*2; float norm=2;
                uint radius=max(1,persistent);
                uint step=max(1,(radius+7)/8);
                [loop] for(uint age=step; age<=radius; age+=step) {
                    uint olderY=(uint)y+age;
                    if(olderY>=ringHeight) break;
                    uint olderSlot=(newestSlot+ringHeight-olderY)%ringHeight;
                    uint olderFlags=RowFlags.Load(int3(x,olderSlot,0));
                    if(!(olderFlags&1)) break;
                    float weight=2.0*(radius+step-age)/(radius+step);
                    float2 older=Rows.Load(int3(x,olderSlot,0));
                    if(mode==0) sum.y+=older.y*weight; else sum.x+=older.x*weight;
                    norm+=weight;
                }
                if(mode==0) data.y=sum.y/norm; else data.x=sum.x/norm;
            }
            validWeight+=w; background+=w*data.y;
            if(mode==0) kinds|=(uint)data.x; else total+=w*data.x;
            changed=changed || ((flags&2)!=0);
        }
    }
    float4 missing=float4(16,23,34,255)/255;
    if(validWeight<=0) return missing;
    float value=total/validWeight;
    float4 result;
    if(mode==0) result=activityColor(kinds,background/validWeight);
    else if(mode==2) result=color(2,(uint)floor(saturate(value/(bits?1:8))*255+0.50001));
    else {
        uint index=(uint)floor(clamp(value*(bits?255:1),0,255)+0.50001);
        if((changes && changed) || (bits && value>0)) index=max(1,index);
        result=color(bits?1:0,index);
    }
    return lerp(missing,result,saturate(validWeight/((hi.x-lo.x)*(hi.y-lo.y))));
}
