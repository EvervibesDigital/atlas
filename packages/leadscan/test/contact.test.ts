import { describe, it, expect } from "vitest";
import * as cheerio from "cheerio";
import { extractContactEmail } from "../src/contact";

const find = (html: string, url = "https://smilesupdentistry.com") => extractContactEmail(cheerio.load(html), html, url);

describe("extractContactEmail", () => {
  it("prefers a mailto: link — an explicit invitation to write there", () => {
    const html = `<p>reach us at hello@smilesupdentistry.com</p><a href="mailto:frontdesk@smilesupdentistry.com">Email us</a>`;
    expect(find(html)).toBe("frontdesk@smilesupdentistry.com");
  });

  it("strips mailto query params", () => {
    expect(find(`<a href="mailto:info@smilesupdentistry.com?subject=Hi%20there">Contact</a>`)).toBe("info@smilesupdentistry.com");
  });

  it("falls back to an address in the page body", () => {
    expect(find(`<footer>Questions? office@smilesupdentistry.com</footer>`)).toBe("office@smilesupdentistry.com");
  });

  it("prefers the site's own domain over an off-domain address", () => {
    const html = `<p>site by studio@webdesignagency.com</p><p>contact@smilesupdentistry.com</p>`;
    expect(find(html)).toBe("contact@smilesupdentistry.com");
  });

  it("prefers a dedicated inbox over a generic one on the same domain", () => {
    const html = `<p>sales@smilesupdentistry.com</p><p>contact@smilesupdentistry.com</p>`;
    expect(find(html)).toBe("contact@smilesupdentistry.com");
  });

  it("rejects addresses that are never a real contact", () => {
    // A wrong address is worse than none: it bounces (hurting sender
    // reputation) or reaches an unrelated third party.
    expect(find(`<a href="mailto:no-reply@smilesupdentistry.com">x</a>`)).toBeUndefined();
    expect(find(`<p>webmaster@smilesupdentistry.com</p>`)).toBeUndefined();
    expect(find(`<p>someone@example.com</p>`)).toBeUndefined();
    expect(find(`<p>a1b2c3d4e5f6a7b8@tracking.io</p>`)).toBeUndefined();
  });

  it("accepts free-mail, which small local businesses genuinely use", () => {
    expect(find(`<p>smilesupdental@gmail.com</p>`)).toBe("smilesupdental@gmail.com");
  });

  it("returns undefined when the page publishes no address", () => {
    expect(find(`<html><body><h1>Call us at 615-555-0100</h1></body></html>`)).toBeUndefined();
  });

  it("survives a malformed page URL without throwing", () => {
    expect(find(`<p>info@smilesupdentistry.com</p>`, "not a url")).toBe("info@smilesupdentistry.com");
  });

  it("does not mistake an image filename for an address", () => {
    expect(find(`<img src="https://cdn.site.com/logo@2x.png">`)).toBeUndefined();
  });
});
