import { z } from 'zod';

export const socialLoginProviderSchema = z.enum(['google', 'github']);
export type SocialLoginProvider = z.infer<typeof socialLoginProviderSchema>;
