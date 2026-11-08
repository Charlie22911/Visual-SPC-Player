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
