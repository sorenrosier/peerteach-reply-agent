# PeerTeach Agent — Test Results
**Run:** 2026-06-02T23:19:58.286Z
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

So glad it works for you! Here are a couple of openings this week:

- Wednesday, June 3 at 2:00 PM EDT
- Thursday, June 4 at 2:00 PM EDT

Do either of those work? It's a quick 20-30 min Zoom call.

-Katie.
```

**Checks:** 45 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*5.6s*

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

Next week works great! Here are a couple of options:

- Monday, June 8 at 1:00 PM CDT
- Tuesday, June 9 at 1:00 PM CDT

Just 20-30 minutes over Zoom. Do either of those work for you?

-Katie.
```

**Checks:** 41 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*6.9s*

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

Thursday, June 4 at 2:00 PM PDT works perfectly! Booked. A calendar invite is on its way to your inbox.

Looking forward to chatting about how PeerTeach can support your students next year.

-Katie.
```

**Checks:** 36 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*7.8s*

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

3:00 PM CDT on Thursday works perfectly!

Can I grab your full name and email to send over the calendar invite?

-Katie.
```

**Checks:** 24 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*5.6s*

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

Booked! A calendar invite is on its way.

Looking forward to chatting Thursday at 2:00 PM EDT.

-Katie.
```

**Checks:** 20 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*4.1s*

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


*2.6s*

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

So glad to hear it! I'd love to walk you through what PeerTeach looks like in the classroom. It's a quick 20-30 min Zoom call.

Here are a couple of times that work:

- Wednesday, June 3 at 11:00 AM PDT
- Thursday, June 4 at 11:00 AM PDT

Do either of those work for you?

-Katie.
```

**Checks:** 59 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*6.6s*

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

No worries at all, two weeks out works! Here are a couple of options:

- Tuesday, June 16 at 1:00 PM CDT
- Wednesday, June 17 at 1:00 PM CDT

It's just a quick 20-30 min Zoom, and I think you'll find it worth your time. Do either of those work for you?

-Katie.
```

**Checks:** 56 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*5.7s*

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

Totally understood, it sounds like you've already got something going. Hope the end of the year wraps up smoothly, and feel free to reach out if anything changes down the road.

-Katie.
```

**Checks:** 34 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*2.0s*

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

Thanks for letting me know! Do you happen to know the principal's name and the best way to reach them?

-Katie.
```

**Checks:** 23 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*1.6s*

---

## 11. Hard no — unsubscribe
**Prospect explicitly asks to be removed.**

**Prospect:** Jane Smith — Principal @ Lincoln Elementary
**Sending from:** katie@peerteach.com

**Their reply:** "Please remove me from your mailing list. I'm not interested."

**Action:** `hard_no`


*1.3s*

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

Thanks for pointing me in the right direction! Do you happen to have Maria's direct email so I can reach out to her?

-Katie.
```

**Checks:** 26 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*2.3s*

---

## 13. Referral — gives direct email
**Prospect gives a direct email address. Should escalate to human to make the intro.**

**Prospect:** Jane Smith — Principal @ Lincoln Elementary
**Sending from:** katie@peerteach.com

**Their reply:** "You should contact our AP directly — her email is maria.gonzalez@school.edu"

**Action:** `escalate`

**Escalate reason:** Prospect provided a direct email address (maria.gonzalez@school.edu) for their AP. A human needs to handle this intro personally.

*2.1s*

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

No cost at all , PeerTeach is completely free for pilot schools, covered by a grant this school year!

It's a structured peer tutoring program for grades 3-8 that runs during regular class time, so there's no extra burden on teachers either. Developed at Stanford and already showing strong results at nearby schools.

Would you have 20-30 minutes for a quick Zoom to see if it's a fit?

-Katie.
```

**Checks:** 71 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*3.1s*

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

Happy to connect! Here are a couple of times that work:

- Wednesday, June 3 at 2:00 PM EDT
- Thursday, June 4 at 2:00 PM EDT

It'll be a quick 20-30 min Zoom call. Do either of those work for you!

Kreg
Co-Founder, PeerTeach
```

**Checks:** 47 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*5.6s*

---
