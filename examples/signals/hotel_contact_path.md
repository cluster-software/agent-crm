---
slug: hotel_contact_path
title: Hotel Contact Path
object: companies
---

```json acrm-signal
{
  "outputs": [
    {
      "key": "operator_status",
      "attribute": "operator_status",
      "title": "Operator status",
      "type": "status",
      "options": [
        "owner_identified:Owner identified",
        "operator_identified:Operator identified",
        "property_contact_only:Property contact only",
        "unclear:Unclear"
      ]
    },
    {
      "key": "operator_name",
      "attribute": "operator_name",
      "title": "Operator name",
      "type": "text"
    },
    {
      "key": "operator_role",
      "attribute": "operator_role",
      "title": "Operator role",
      "type": "select",
      "options": [
        "owner:Owner",
        "family_owner:Family owner",
        "proprietor:Proprietor",
        "general_manager:General manager",
        "managing_director:Managing director",
        "operating_entity:Operating entity",
        "property_contact:Property contact",
        "unclear:Unclear"
      ]
    },
    {
      "key": "outreach_path",
      "attribute": "outreach_path",
      "title": "Outreach path",
      "type": "text"
    }
  ]
}
```

Find a practical outreach path to a real hotelier or operator for this hotel.

Prioritize non-LinkedIn public sources:

1. The hotel's own imprint, legal notice, privacy policy, footer, team, press, or contact pages.
2. Local press articles that name owners, proprietors, general managers, managing directors, or family operators.
3. Tourism board, chamber of commerce, hospitality association, destination marketing, or awards pages.
4. OTA/review pages only when they clearly name management or ownership.

Classify `operator_status` as:

- `owner_identified`: a person, family, or owning entity is identified.
- `operator_identified`: an operating company, GM, managing director, proprietor, or manager is identified, but ownership is not clear.
- `property_contact_only`: only a generic property channel is available.
- `unclear`: evidence is too weak or conflicting.

Classify `operator_role` as:

- `owner`: a named individual owner is identified.
- `family_owner`: a named family ownership/operator group is identified.
- `proprietor`: a proprietor/innkeeper is identified.
- `general_manager`: a GM or hotel manager is the best named operator contact.
- `managing_director`: a managing director, Geschäftsführer, or equivalent officer is identified.
- `operating_entity`: only an operating company/entity is identified.
- `property_contact`: only a generic property contact route is available.
- `unclear`: evidence is too weak or conflicting.

For `outreach_path`, prefer a direct email or named contact route. If only a contact form or phone number is available, state that plainly. Include citations for each factual claim whenever possible.
