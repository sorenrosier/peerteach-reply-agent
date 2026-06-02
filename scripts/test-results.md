# PeerTeach Agent — Test Results
**Run:** 2026-06-02T22:54:28.071Z
**Model:** claude-sonnet-4-5-20251022
**Calendly:** mocked (no real API calls)

---

## 1. Simple scheduling — no prior context
**Prospect says yes and asks when you are free. No prior thread.**

**Prospect:** Jane Smith — Principal @ Lincoln Elementary, Brooklyn NY
**Sending from:** katie@peerteach.com

**Their reply:** "Hi Katie, yes happy to hop on a call! When are you available this week?"

**Action:** `draft`

**Draft reply:**
```
Hi Jane,

So glad it's a good time. I have two spots open this week: Wednesday, June 3 at 2:00 PM EDT or Thursday, June 4 at 2:00 PM EDT. It's a quick 20-30 min Zoom.

Do either of those work for you?

Katie
PeerTeach
```

**Checks:** 45 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*5.4s*

---

## 2. Prospect requests next week specifically
**Prospect is available but asks for next week specifically.**

**Prospect:** Jane Smith — Principal @ Westwood Middle School, Chicago IL
**Sending from:** katie@peerteach.com

**Their reply:** "Sure, I'd be happy to chat. Can we do something next week though? This week is slammed."

**Action:** `draft`

**Draft reply:**
```
Hi Jane,

Next week works great. Two options:

Monday, June 8 at 1:00 PM CDT or Tuesday, June 9 at 1:00 PM CDT.

Either one is just 20-30 minutes over Zoom. Do either of those work for you?

Katie
PeerTeach
```

**Checks:** 40 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*4.6s*

---

## 3. Prospect proposes a specific time
**Prospect offers a specific time. Agent should confirm it if available, not propose new times.**

**Prospect:** Jane Smith — Principal @ Sunset Elementary, San Diego CA
**Sending from:** katie@peerteach.com

**Their reply:** "Yes, let's do it. How about Thursday at 2pm?"

**Action:** `draft` (meeting booked)

**Draft reply:**
```
Hi Jane,

Booked , calendar invite is on its way.
https://calendly.com/reschedulings/MOCK

Looking forward to Thursday at 2:00 PM PDT!

Katie
PeerTeach
```

**Checks:** 21 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*11.7s*

---

## 4. Multi-turn — agent already proposed times, prospect counters
**Prior thread shows agent proposed Tuesday 11am and Thursday 2pm. Prospect asks for 3pm instead.**

**Prospect:** Jane Smith — Principal @ Riverside Elementary, Austin TX
**Sending from:** katie@peerteach.com

<details><summary>Prior thread</summary>

**[Us]** Hi Jane, I wanted to share something that could help your students with math — PeerTeach is a free peer tutoring platform for grades 3-8. Would you be open to a quick 20-min Zoom?

**[Prospect]** Hi Katie, yes happy to chat! When are you free?

**[Us]** Hi Jane, how does Tuesday, June 2 at 11:00 AM CDT or Thursday, June 4 at 2:00 PM CDT work?

Katie
PeerTeach

**[Prospect]** Thursday works but can we do 3pm instead of 2?

</details>

**Their reply:** "Thursday works but can we do 3pm instead of 2?"

**Action:** `draft`

**Draft reply:**
```
Hi Jane,

Thursday, June 4 at 3:00 PM CDT works perfectly. Just reply to confirm and I'll send over the calendar invite!

Katie
PeerTeach
```

**Checks:** 24 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*6.6s*

---

## 5. Booking confirmation — prospect confirms the proposed time
**Prior thread shows 2pm Thursday was proposed. Prospect confirms. Agent should book.**

**Prospect:** Jane Smith — Principal @ Lincoln Elementary, Brooklyn NY
**Sending from:** katie@peerteach.com

<details><summary>Prior thread</summary>

**[Us]** Hi Jane, I wanted to share something about PeerTeach — a free math tutoring platform for grades 3-8.

**[Prospect]** Yes, let's chat! When works for you?

**[Us]** Hi Jane, how does Tuesday, June 3 at 11:00 AM EDT or Thursday, June 5 at 2:00 PM EDT work?

Katie
PeerTeach

**[Prospect]** Thursday at 2pm works perfectly for me!

</details>

**Their reply:** "Thursday at 2pm works perfectly for me!"

**Action:** `draft` (meeting booked)

**Draft reply:**
```
Hi Jane,

Booked , calendar invite is on its way.
https://calendly.com/reschedulings/MOCK

Katie
PeerTeach
```

**Checks:** 13 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*3.8s*

---

## 6. No reply needed — prospect just says thanks
**Prospect sends a simple acknowledgment. No reply needed.**

**Prospect:** Jane Smith — Principal @ Lincoln Elementary
**Sending from:** katie@peerteach.com

<details><summary>Prior thread</summary>

**[Us]** Hi Jane, I wanted to reach out about PeerTeach — a free math tutoring platform for grades 3-8.

**[Prospect]** Yes, let's connect! When works for you?

**[Us]** Hi Jane, how does Thursday, June 5 at 2:00 PM EDT work?

Katie
PeerTeach

**[Prospect]** Thursday at 2pm works perfectly!

**[Us]** Booked — calendar invite is on its way.

Katie
PeerTeach

**[Prospect]** Great, thanks for the info! Looking forward to it.

</details>

**Their reply:** "Great, thanks for the info! Looking forward to it."

**Action:** `no_reply`


*2.4s*

---

## 7. California timezone
**Prospect at LA school. Times should be in PT not ET.**

**Prospect:** Jane Smith — Principal @ Greenwood Elementary, Los Angeles CA
**Sending from:** katie@peerteach.com

**Their reply:** "Yes, I'd love to learn more. When are you free?"

**Action:** `draft`

**Draft reply:**
```
Hi Jane,

Happy to connect! I have two spots open this week: Wednesday, June 3 at 11:00 AM PDT or Thursday, June 4 at 11:00 AM PDT. It's just a quick 20-30 min Zoom call.

Does either of those work for you?

Katie
PeerTeach
```

**Checks:** 44 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*5.9s*

---

## 8. Prospect requests 2 weeks from now
**Prospect explicitly asks for availability 2 weeks out.**

**Prospect:** Jane Smith — Principal @ Oak Park Middle School, Dallas TX
**Sending from:** katie@peerteach.com

**Their reply:** "Interested! School year is wrapping up so I'm slammed this week and next. Can we find something in 2 weeks?"

**Action:** `draft`

**Draft reply:**
```
Hi Jane,

No problem at all, two weeks works great. I have Tuesday, June 16 at 1:00 PM CDT or Wednesday, June 17 at 1:00 PM CDT open for a quick 20-30 min Zoom.

Does either of those work for you?

Katie
PeerTeach
```

**Checks:** 43 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*5.2s*

---

## 9. Soft no
**Prospect politely declines for now.**

**Prospect:** Jane Smith — Principal @ Lincoln Elementary
**Sending from:** katie@peerteach.com

**Their reply:** "Thanks for reaching out but we already have a tutoring program in place and aren't looking to add anything new this year."

**Action:** `draft`

**Draft reply:**
```
Hi Jane,

Totally understand. Hope the rest of the year goes well, and feel free to reach out if anything changes down the road.

Katie
PeerTeach
```

**Checks:** 26 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*2.6s*

---

## 10. Wrong person
**Email went to the wrong person. Agent should ask for the right contact, not escalate.**

**Prospect:** Jane Smith — School Secretary @ Lincoln Elementary
**Sending from:** katie@peerteach.com

**Their reply:** "Hi, I'm actually the school secretary. I don't handle curriculum decisions. You'd want to talk to our principal."

**Action:** `draft`

**Draft reply:**
```
Hi Jane,

Sorry for the confusion , do you know who the principal is and if there's a good way to reach them directly?

Katie
PeerTeach
```

**Checks:** 26 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*1.7s*

---

## 11. Hard no — unsubscribe
**Prospect explicitly asks to be removed.**

**Prospect:** Jane Smith — Principal @ Lincoln Elementary
**Sending from:** katie@peerteach.com

**Their reply:** "Please remove me from your mailing list. I'm not interested."

**Action:** `hard_no`


*1.6s*

---

## 12. Referral — name only, no email
**Prospect refers to someone else by name but no email. Agent should ask for the email.**

**Prospect:** Jane Smith — Principal @ Lincoln Elementary
**Sending from:** katie@peerteach.com

**Their reply:** "You should talk to our instructional coach, Maria Gonzalez. She handles all curriculum decisions."

**Action:** `draft`

**Draft reply:**
```
Hi Jane,

Thanks for pointing me in the right direction , do you happen to have Maria's direct email so I can reach out to her?

Katie
PeerTeach
```

**Checks:** 28 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*1.6s*

---

## 13. Referral — gives direct email
**Prospect gives a direct email address. Should escalate to human to make the intro.**

**Prospect:** Jane Smith — Principal @ Lincoln Elementary
**Sending from:** katie@peerteach.com

**Their reply:** "You should contact our AP directly — her email is maria.gonzalez@school.edu"

**Action:** `escalate`

**Escalate reason:** Prospect provided a direct email address (maria.gonzalez@school.edu) for a referral — a human needs to handle this intro personally.

*3.0s*

---

## 14. Soft yes — asks about cost
**Prospect interested but asks if it costs anything.**

**Prospect:** Jane Smith — Principal @ Lincoln Elementary
**Sending from:** katie@peerteach.com

**Their reply:** "This sounds interesting, but is there a cost involved? We have basically no budget right now."

**Action:** `draft`

**Draft reply:**
```
Hi Jane,

No cost at all , PeerTeach is fully free for pilot schools, covered by a grant this school year.

Would it be worth a quick 20-30 min Zoom call to walk through how it works? Happy to find a time that fits your schedule.

Katie
PeerTeach
```

**Checks:** 48 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*2.2s*

---

## 15. Kreg sending — check identity
**Same scenario but from Kreg — should sign as Kreg Co-Founder.**

**Prospect:** Jane Smith — Principal @ Maple Elementary, Boston MA
**Sending from:** kreg@peerteach.com

**Their reply:** "Yes happy to chat, when are you free?"

**Action:** `draft`

**Draft reply:**
```
Hi Jane,

Great to hear from you. A few times that work on my end: Wednesday, June 3 at 2:00 PM EDT or Thursday, June 4 at 2:00 PM EDT.

Either of those work for you?

Kreg
Co-Founder, PeerTeach
```

**Checks:** 39 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*5.0s*

---
