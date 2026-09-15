import { createHash } from "node:crypto";
import { z } from "zod";

const JobUrlSchema = z.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "https:" || protocol === "http:";
}, "The job link must use HTTP or HTTPS.");

export const ExtractedJobSchema = z.strictObject({
  title: z.string().trim().min(1),
  link: JobUrlSchema.nullable(),
});
export type ExtractedJob = Readonly<z.infer<typeof ExtractedJobSchema>>;

export const JobIdentitySchema = z.strictObject({
  organizationName: z.string().trim().min(1),
  title: z.string().trim().min(1),
  link: JobUrlSchema,
  pageUrl: JobUrlSchema,
});
export type JobIdentity = Readonly<z.infer<typeof JobIdentitySchema>>;

export function identifyJob(organizationName: string, pageUrl: string, job: ExtractedJob): JobIdentity {
  return JobIdentitySchema.parse({ organizationName, title: job.title, link: job.link ?? pageUrl, pageUrl });
}

export function jobIdentityKey(job: JobIdentity): string {
  return createHash("sha256").update(JSON.stringify([job.organizationName, job.title, job.link])).digest("hex");
}
