"""Read a Win32 RCDATA resource as data without running the executable."""
import ctypes
from pathlib import Path


def read_resource(executable: Path, identifier: int) -> bytes:
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    pointer = ctypes.c_void_p
    kernel.LoadLibraryExW.argtypes = [ctypes.c_wchar_p, pointer, ctypes.c_uint32]
    kernel.LoadLibraryExW.restype = pointer
    kernel.FindResourceW.argtypes = [pointer, pointer, pointer]
    kernel.FindResourceW.restype = pointer
    kernel.LoadResource.argtypes = [pointer, pointer]
    kernel.LoadResource.restype = pointer
    kernel.SizeofResource.argtypes = [pointer, pointer]
    kernel.SizeofResource.restype = ctypes.c_uint32
    kernel.LockResource.argtypes = [pointer]
    kernel.LockResource.restype = pointer
    kernel.FreeLibrary.argtypes = [pointer]
    kernel.FreeLibrary.restype = ctypes.c_int
    module = kernel.LoadLibraryExW(str(executable.resolve()), None, 0x22)
    if not module:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        resource = kernel.FindResourceW(module, pointer(identifier), pointer(10))
        if not resource:
            raise RuntimeError(f"Missing embedded resource {identifier}")
        size = kernel.SizeofResource(module, resource)
        data = kernel.LockResource(kernel.LoadResource(module, resource))
        if not data or not size:
            raise RuntimeError(f"Empty embedded resource {identifier}")
        return ctypes.string_at(data, size)
    finally:
        kernel.FreeLibrary(module)
