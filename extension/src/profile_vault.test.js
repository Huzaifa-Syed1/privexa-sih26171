/**
 * profile_vault.test.js — Unit tests for Local Profile Vault
 */

import { describe, it, expect, beforeEach } from "vitest";
import { vault } from "./profile_vault.js";

describe("ProfileVault", () => {
  beforeEach(async () => {
    await vault.setProfile({
      name: "Test User",
      email: "test@example.com",
      phone: "1234567890",
      address: "456 Test Ave",
    });
    await vault.setCredential("example.com", "testuser", "SecretPass123!");
  });

  it("returns configured profile data", () => {
    const profile = vault.getProfile();
    expect(profile.name).toBe("Test User");
    expect(profile.email).toBe("test@example.com");
  });

  it("resolves email fields correctly", () => {
    const el = document.createElement("input");
    el.type = "email";
    el.name = "user_email";

    const val = vault.resolveLocalValue(el, "example.com");
    expect(val).toBe("test@example.com");
  });

  it("resolves password fields correctly from vault credentials", () => {
    const el = document.createElement("input");
    el.type = "password";
    el.id = "user_pass";

    const val = vault.resolveLocalValue(el, "example.com");
    expect(val).toBe("SecretPass123!");
  });

  it("resolves phone fields correctly", () => {
    const el = document.createElement("input");
    el.type = "tel";
    el.placeholder = "Enter mobile number";

    const val = vault.resolveLocalValue(el, "example.com");
    expect(val).toBe("1234567890");
  });

  it("resolves full name fields correctly", () => {
    const el = document.createElement("input");
    el.type = "text";
    el.setAttribute("aria-label", "Full Name");

    const val = vault.resolveLocalValue(el, "example.com");
    expect(val).toBe("Test User");
  });
});
