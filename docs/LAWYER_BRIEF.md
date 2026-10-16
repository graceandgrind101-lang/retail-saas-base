# Request for Legal Opinion: Retail Point-of-Sale Software for Ethiopian Shops

**From:** Yirael Tibebu, [company name, to be registered] · [phone] · [email]
**Date:** [date]
**Requested:** a written opinion on the questions below, plus the documents listed in §4. Please quote a fee and timeline.

---

## 1. What we are building

A subscription software service (SaaS) for small and medium shops in Ethiopia, starting with phone/electronics shops and mini-markets in Addis Ababa. Shops use it on phones, tablets and computers to:

- record sales, stock and staff activity
- record customers who pay later (a "Dube" record book: no interest, no lending, no money handled by us)
- **check that a customer's Telebirr or bank transfer is genuine** before goods leave the shop. Fake payment screenshots are a common fraud.

**We never hold, move or receive the shops' money.** Customers pay the shop directly, into the shop's own Telebirr or bank account. We only help the shop check that the payment happened.

**Timeline:**
- **Free pilot** with 2–3 shops in about 4 months.
- **Paid launch** after that, priced at about 2,000–5,000 ETB per shop per month.

## 2. The data we would hold

| Whose data | What | Why |
|---|---|---|
| Shop owners and staff | Name, phone, email, PIN (stored only in scrambled form), activity log | Login and accountability |
| Shops' customers (optional) | Name, phone, purchases, phone serial numbers (IMEI) for warranty, amounts owed (Dube) | Warranty lookup, credit records |
| Payments | Transaction reference number, amount, payer name as shown on the receipt, receipt screenshot | Payment checking |
| Customers paying through a link (later) | Phone number, a random device identifier | Preventing discount abuse |

**Hosting:** to start, all data would be stored with large international cloud providers (Supabase, with servers in the EU; Cloudflare). We plan to move to an Ethiopian data centre later, and the software is built so that move is straightforward.

## 3. Questions

**A. Needed before the free pilot**

1. **Data localisation (Proclamation 1321/2024, Art. 22).** May we store personal data on servers outside Ethiopia:
   - during a free pilot with 2–3 shops that sign a written consent?
   - after we start charging?

   If not, what is the minimum that satisfies the law: a copy kept in Ethiopia, or primary storage in Ethiopia? And **by when** must we move? This decides our hosting budget.
2. **Pilot agreement and privacy notice.** What must a pilot agreement with a shop contain? What notice must shops show their own customers (in English and Amharic)?
3. **Registration with the Ethiopian Communications Authority.** Must we register as a data processor (for the shops) before the pilot, or only before paid launch? Must the shops register as controllers?

**B. Needed before paid launch**

4. **Shared fraud check across shops.** We want to tell a shop "this payment reference was already used before, on [date]", including when it was used at *another* shop. The other shop's name, the payer and the amount would never be revealed; we would store only a scrambled (hashed) form of the reference, kept for 12–24 months. Is "legitimate interest" a valid legal basis for this? What disclosures, retention limits or registrations does it need?
5. **Automatic checking of bank receipt pages.** Banks and Telebirr publish a receipt page for each transaction, reachable with the reference number (the same link they send by SMS). May our software open these pages automatically to confirm a payment the shop has received? Consider the Computer Crime Proclamation 958/2016 and the banks' terms of use. May we advertise the result as "verified"?
6. **Payment regulation.** Since we only check payments and never hold funds, are we outside the scope of the payment system laws (Proclamation 718/2011 as amended by 1282/2023)? Does that change if a shop offers its customers a small discount (paid by the shop) for paying through our payment link?
7. **E-invoicing (Directive 1142).** The directive appears to cover software providers that run sales registers. Does it apply to us? If so, what licence, guarantees and deadlines apply? Until we are certified, may our receipts carry a "not a fiscal receipt" label?
8. **Credit records (Dube).** Shops record who owes them money and when it was repaid. We charge no interest and lend nothing. Does this need any licence?
9. **Referral programme.** A shop that refers other paying shops gets a discount on its own subscription (one level only, never cash). Is this compliant with Proclamation 813/2013 (pyramid schemes)?
10. **Company and payments abroad.** What business licence category fits a SaaS company? Is there a lawful way for an Ethiopian PLC to pay monthly USD fees to foreign cloud providers?

## 4. Documents requested

1. Pilot agreement (with data consent)
2. Terms of service for paying shops
3. Data processing agreement between us and each shop
4. Privacy notice for shops' customers, in English and Amharic
5. A short checklist of registrations and their deadlines

## 5. What would help us most

A short written answer to **questions 1–3 first**, so the pilot can start. Questions 4–10 can follow before paid launch.
