import { describe, expect, it } from "vitest";
import { UnavailableCertificationRepository } from "../../src/db/unavailable-repository.js";
import { RepositoryUnavailableError } from "../../src/db/repository.js";

describe("standalone unavailable certification repository", () => {
  it("returns empty values for read-only methods", async () => {
    const repository = new UnavailableCertificationRepository();

    await expect(repository.listCriteria()).resolves.toEqual([]);
    await expect(repository.getCriteria(["criterion"])).resolves.toEqual([]);
    await expect(repository.listPolicies()).resolves.toEqual([]);
    await expect(repository.getPolicy("policy")).resolves.toBeNull();
    await expect(repository.getActivePolicy()).resolves.toBeNull();
    await expect(repository.getBadgeBySubject(1, "commit", "hash", "ruleset")).resolves.toBeNull();
    await expect(repository.getBadge("uid")).resolves.toBeNull();
    await expect(repository.listBadges(100)).resolves.toEqual([]);
  });

  it("rejects every mutation and issuance persistence method", async () => {
    const repository = new UnavailableCertificationRepository();
    const operations = [
      () => repository.nextPolicyVersion(),
      () => repository.createDraftPolicy(undefined as never),
      () => repository.updateDraftPolicy(undefined as never, "administrator"),
      () => repository.publishPolicy("policy", "administrator", new Date(0).toISOString()),
      () => repository.saveRejectedAnalysis(undefined as never),
      () => repository.saveIssuedBadge(undefined as never),
      () => repository.revokeBadge(undefined as never),
    ];

    for (const operation of operations) {
      await expect(operation()).rejects.toBeInstanceOf(RepositoryUnavailableError);
    }
  });
});
