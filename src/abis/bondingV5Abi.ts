export const bondingV5Abi = [
  {
    inputs: [
      { internalType: "string", name: "name_", type: "string" },
      { internalType: "string", name: "ticker_", type: "string" },
      { internalType: "uint8[]", name: "cores_", type: "uint8[]" },
      { internalType: "string", name: "desc_", type: "string" },
      { internalType: "string", name: "img_", type: "string" },
      { internalType: "string[4]", name: "urls_", type: "string[4]" },
      { internalType: "uint256", name: "purchaseAmount_", type: "uint256" },
      { internalType: "uint256", name: "startTime_", type: "uint256" },
      { internalType: "uint8", name: "launchMode_", type: "uint8" },
      { internalType: "uint16", name: "airdropBips_", type: "uint16" },
      { internalType: "bool", name: "needAcf_", type: "bool" },
      { internalType: "uint8", name: "antiSniperTaxType_", type: "uint8" },
      { internalType: "bool", name: "isProject60days_", type: "bool" },
    ],
    name: "preLaunch",
    outputs: [
      { internalType: "address", name: "", type: "address" },
      { internalType: "address", name: "", type: "address" },
      { internalType: "uint256", name: "", type: "uint256" },
      { internalType: "uint256", name: "", type: "uint256" },
    ],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;
