(function () {
  const MODELS = [
    {
      id: "qwen2.5-0.5b",
      label: "Qwen2.5 0.5B Instruct",
      model: "onnx-community/Qwen2.5-0.5B-Instruct-ONNX",
      revision: "aaabb83c90b732de9a0b4408002d099d92969cd1",
      dtype: "q4f16",
      dtypeFallback: "q4",
      approxBytes: 500 * 1024 * 1024,
      params: "0.5B",
      license: "Apache-2.0",
      note: "Fastest Qwen option. Best for weaker GPUs or quick smoke tests.",
    },
    {
      id: "qwen2.5-1.5b",
      label: "Qwen2.5 1.5B Instruct",
      model: "onnx-community/Qwen2.5-1.5B-Instruct",
      revision: "d54957e3af1be04546436e874a60fe386041b244",
      dtype: "q4f16",
      dtypeFallback: "q4",
      approxBytes: 1280 * 1024 * 1024,
      params: "1.5B",
      license: "Apache-2.0",
      note: "Recommended balance of planning quality, speed, and memory.",
      recommended: true,
    },
    {
      id: "lfm2.5-350m",
      label: "LFM2.5 350M",
      model: "onnx-community/LFM2.5-350M-ONNX",
      revision: "7dd4999565b0342c381ba90a3d8fc467d6df19c4",
      dtype: "q4f16",
      dtypeFallback: "q4",
      approxBytes: 270 * 1024 * 1024,
      params: "350M",
      license: "LFM Open License",
      note: "Smallest option. Lowest memory use, with weaker graph reasoning.",
    },
    {
      id: "llama-3.2-1b",
      label: "Llama 3.2 1B Instruct",
      model: "onnx-community/Llama-3.2-1B-Instruct-ONNX",
      revision: "82ac69368916173bad498ad390290faab92d4fb0",
      dtype: "q4f16",
      dtypeFallback: "q4",
      approxBytes: 1120 * 1024 * 1024,
      params: "1B",
      license: "Llama 3.2 Community License",
      note: "Compact alternative when you prefer the Llama family.",
    },
  ];

  const DEFAULT_MODEL_ID = "qwen2.5-1.5b";
  const byId = Object.fromEntries(MODELS.map((model) => [model.id, model]));

  globalThis.MELON_AI = {
    MODELS,
    byId,
    DEFAULT_MODEL_ID,
    HF_ORIGINS: [
      "https://huggingface.co/*",
      "https://*.hf.co/*",
      "https://*.huggingface.co/*",
    ],
  };
})();
