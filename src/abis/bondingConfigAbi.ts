export const bondingConfigAbi = [
  {
    inputs: [
      { internalType: "bool", name: "isScheduledLaunch_", type: "bool" },
      { internalType: "bool", name: "needAcf_", type: "bool" },
    ],
    name: "calculateLaunchFee",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;
