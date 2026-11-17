import { z } from 'zod';

export const managementProofObservationSchema = z.strictObject({
	point: z.literal('before-provider-owner-read'),
	requestId: z.string(),
});
export type ManagementObservation = z.infer<typeof managementProofObservationSchema>;
