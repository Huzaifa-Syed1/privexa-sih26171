/**
 * profile_vault.js — Local Profile & Credential Vault for Prism.
 *
 * Privacy Invariant:
 * Profile data and credentials are stored strictly in local device storage
 * (chrome.storage.local or memory fallback) and NEVER sent across the wire.
 * When the server asks to fill a field ("type" action with value_source),
 * this module resolves the field locally.
 */

const DEFAULT_PROFILE = {
  name: "Huzaifa Khan",
  email: "huzaifa@example.com",
  phone: "9876543210",
  address: "123 Innovation Park, Tech Hub",
  city: "Bengaluru",
  state: "Karnataka",
  pincode: "560001",
  dob: "1999-05-15",
};

const DEFAULT_CREDENTIALS = {
  "localhost": { username: "huzaifa@example.com", password: "MySecretPassword123" },
  "default": { username: "huzaifa@example.com", password: "MySecretPassword123" },
};

class ProfileVault {
  constructor() {
    this._profile = { ...DEFAULT_PROFILE };
    this._credentials = { ...DEFAULT_CREDENTIALS };
    this._loaded = false;
  }

  async load() {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      try {
        const data = await chrome.storage.local.get(["prism_profile", "prism_credentials"]);
        if (data.prism_profile) this._profile = { ...DEFAULT_PROFILE, ...data.prism_profile };
        if (data.prism_credentials) this._credentials = { ...DEFAULT_CREDENTIALS, ...data.prism_credentials };
      } catch (err) {
        console.warn("[prism/vault] chrome.storage unavailable, using local memory fallback", err);
      }
    }
    this._loaded = true;
  }

  async save() {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      try {
        await chrome.storage.local.set({
          prism_profile: this._profile,
          prism_credentials: this._credentials,
        });
      } catch (err) {
        console.warn("[prism/vault] save failed", err);
      }
    }
  }

  getProfile() {
    return { ...this._profile };
  }

  async setProfile(profileData) {
    this._profile = { ...this._profile, ...profileData };
    await this.save();
  }

  getCredential(domain = "default") {
    return this._credentials[domain] || this._credentials["default"] || { username: "", password: "" };
  }

  async setCredential(domain, username, password) {
    this._credentials[domain] = { username, password };
    await this.save();
  }

  /**
   * Get a field value by its explicit LocalSource enum string.
   *
   * @param {string} source - e.g. "profile.name" or "credential.current_site.password"
   * @param {string} domain
   * @returns {string|null}
   */
  getValueBySource(source, domain = "default") {
    const cred = this.getCredential(domain);
    switch (source) {
      case "profile.name": return this._profile.name;
      case "profile.email": return this._profile.email;
      case "profile.phone": return this._profile.phone;
      case "profile.address": return this._profile.address;
      case "profile.city": return this._profile.city;
      case "profile.state": return this._profile.state;
      case "profile.pincode": return this._profile.pincode;
      case "profile.dob": return this._profile.dob;
      case "credential.current_site.username": return cred.username;
      case "credential.current_site.password": return cred.password;
      default: return null;
    }
  }

  /**
   * Resolve a field value locally based on element attributes or label.
   * NEVER returns a server-controlled value.
   *
   * @param {Element} element
   * @param {string} domain
   * @returns {string|null}
   */
  resolveLocalValue(element, domain = "default") {
    if (!element) return null;

    const type = (element.getAttribute("type") || "").toLowerCase();
    const name = (element.getAttribute("name") || "").toLowerCase();
    const id = (element.getAttribute("id") || "").toLowerCase();
    const auto = (element.getAttribute("autocomplete") || "").toLowerCase();
    const placeholder = (element.getAttribute("placeholder") || "").toLowerCase();
    const label = (element.getAttribute("aria-label") || "").toLowerCase();

    const text = `${type} ${name} ${id} ${auto} ${placeholder} ${label}`;

    const cred = this.getCredential(domain);

    if (type === "password" || text.includes("pass")) {
      return cred.password || DEFAULT_CREDENTIALS.default.password;
    }
    if (type === "email" || text.includes("email") || auto.includes("email")) {
      return this._profile.email || cred.username;
    }
    if (type === "tel" || text.includes("phone") || text.includes("mobile")) {
      return this._profile.phone;
    }
    if (text.includes("address") || text.includes("street")) {
      return this._profile.address;
    }
    if (text.includes("city")) {
      return this._profile.city;
    }
    if (text.includes("state")) {
      return this._profile.state;
    }
    if (text.includes("zip") || text.includes("pin") || text.includes("postal") || text.includes("pincode")) {
      return this._profile.pincode;
    }
    if (text.includes("dob") || text.includes("birth")) {
      return this._profile.dob;
    }
    if (text.includes("username")) {
      return cred.username || this._profile.email;
    }
    if (text.includes("name") || text.includes("fname") || text.includes("lname")) {
      return this._profile.name;
    }
    if (text.includes("user")) {
      return cred.username || this._profile.email;
    }

    // Default fallback: current value if present, or profile email for generic inputs
    return element.value || this._profile.email;
  }
}

export const vault = new ProfileVault();
