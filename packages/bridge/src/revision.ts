import { z } from "zod";

export const expectedRevision = z
	.number()
	.int()
	.nonnegative()
	.describe("The revision the ops were planned against, from the digest");
