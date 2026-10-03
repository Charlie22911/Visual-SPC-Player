#pragma once

#include <cstdio>

#define CHECK(expression)                                                               \
    do {                                                                                \
        if (!(expression)) {                                                            \
            std::fprintf(stderr, "CHECK failed: %s (%s:%d)\n", #expression, __FILE__, \
                         __LINE__);                                                      \
            return 1;                                                                   \
        }                                                                               \
    } while (false)
