// Public build-time switches must match the API switches in the publishing manifest.
export const liveClassesEnabled = process.env.NEXT_PUBLIC_ENABLE_LIVE_CLASSES !== "false";
export const onlinePaymentsEnabled = process.env.NEXT_PUBLIC_ENABLE_ONLINE_PAYMENTS !== "false";
