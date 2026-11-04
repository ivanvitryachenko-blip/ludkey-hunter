# LudKey Hunter CUDA agent. Requires: NVIDIA GPU + CUDA toolkit (nvcc).
# Set SM to your card's compute capability:
#   GTX 1650 = 75,  RTX 3070 = 86,  RTX 5070/5090 (Blackwell) = 120 (use CUDA 12.8+)
SM ?= 75
NVCC ?= nvcc
NVCCFLAGS = -O3 -arch=sm_$(SM) -lineinfo

all: ludkey_cuda

ludkey_cuda: src/main.cu src/field.cuh src/ec.cuh src/sha256.cuh src/ripemd160.cuh
	$(NVCC) $(NVCCFLAGS) src/main.cu -o ludkey_cuda

# Compile and run the GPU-vs-CPU self-test only.
validate: ludkey_cuda
	./ludkey_cuda --validate-only

clean:
	rm -f ludkey_cuda

.PHONY: all validate clean
