/** The kinds of device a person can say theirs is when connecting it. */
export const DEVICE_KINDS_FOR_FORM = ["pos", "phone", "tablet", "desktop"] as const;
export type DeviceKindForForm = (typeof DEVICE_KINDS_FOR_FORM)[number];
