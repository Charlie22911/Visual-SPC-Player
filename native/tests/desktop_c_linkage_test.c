#include "desktop_api.h"
#include "backend/spc_metadata.h"
int main(void) {
    spc_metadata_t metadata;
    spc_native_instance* instance = spc_native_create();
    if (!instance || spc_native_abi_version() != 1) return 1;
    if (spc_metadata_parse(0, 0, &metadata)) return 2;
    spc_native_destroy(instance);
    return 0;
}
