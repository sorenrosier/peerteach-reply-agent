# PeerTeach Agent — Test Results
**Run:** 2026-06-10T14:36:10.568Z
**Model:** claude-sonnet-4-6
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

So glad to hear it! Here are a couple of times that work for a quick 30-minute Zoom this week:

- Today at 3:00 PM EDT
- Tomorrow at 2:00 PM EDT

Happy to find another time if those don't work!

-Katie
```

**Checks:** 44 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*11.1s*

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

Next week works perfectly , totally understand this time of year is hectic!

Here are a couple of options for a quick 30-minute Zoom:

- This Monday at 1:00 PM CDT
- This Tuesday at 1:00 PM CDT

Do either of those work for you? Happy to find another time if not.

-Katie
```

**Checks:** 55 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*17.2s*

---

## 3. Prospect proposes a specific time
**Prospect offers a specific time. Agent should confirm it if available, not propose new times.**

**Prospect:** Jane Smith — Principal @ Sunset Elementary, San Diego CA
**Sending from:** katie@peerteach.com

**Their reply:** "Yes, let's do it. How about Thursday at 2pm?"

**Action:** `draft` (books on Send)

**Draft reply:**
```
Hi Jane,

Perfect, that works on my end. I just sent over a calendar invite with the Zoom link. Looking forward to connecting!

-Katie
```

**Checks:** 24 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*26.8s*

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

Thursday June 4 has already passed, so let's find a new time! I have two spots available:

- Today at 2:00 PM CDT
- Tomorrow at 1:00 PM CDT

Do either of those work? Happy to find another time if not.

-Katie
```

**Checks:** 44 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*19.2s*

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

**Action:** `draft` (books on Send)

**Draft reply:**
```
Hi Jane,

Perfect, that works on my end. I just sent over a calendar invite with the Zoom link. Looking forward to connecting!

-Katie
```

**Checks:** 24 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*12.2s*

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


*10.1s*

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

So glad to hear it! I'd love to set up a quick 30-minute Zoom to walk you through PeerTeach and share what we've seen at pilot schools.

Here are a couple of times that work for me:

- Today at 12:00 PM PDT
- Tomorrow at 11:00 AM PDT

Happy to find another time if those don't work , just let me know what's easiest as you close out the year.

-Katie
```

**Checks:** 74 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*16.6s*

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

Totally understand, no worries at all! Here are a couple of options for a quick 30-minute Zoom:

- Wednesday, June 24 at 1:00 PM CDT
- Thursday, June 25 at 1:00 PM CDT

Happy to find another time if those don't work.

-Katie
```

**Checks:** 45 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*20.9s*

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

Totally understand, no worries at all. Hope the rest of the year finishes strong, and feel free to reach out if anything changes down the road.

-Katie.
```

**Checks:** 29 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*2.2s*

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

Sorry for the mix-up! Do you know who the right principal is to reach out to, or have a direct email I could use?

-Katie.
```

**Checks:** 27 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*7.0s*

---

## 11. Hard no — unsubscribe
**Prospect explicitly asks to be removed.**

**Prospect:** Jane Smith — Principal @ Lincoln Elementary
**Sending from:** katie@peerteach.com

**Their reply:** "Please remove me from your mailing list. I'm not interested."

**Action:** `hard_no`


*7.6s*

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

Thanks for the heads up! Do you happen to have Maria's direct email so I can reach out to her?

-Katie
```

**Checks:** 23 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*1.8s*

---

## 13. Referral — gives direct email
**Prospect gives a direct email address. Should escalate to human to make the intro.**

**Prospect:** Jane Smith — Principal @ Lincoln Elementary
**Sending from:** katie@peerteach.com

**Their reply:** "You should contact our AP directly — her email is maria.gonzalez@school.edu"

**Action:** `escalate`

**Escalate reason:** Referral — Maria Gonzalez (AP) at maria.gonzalez@school.edu. Human needs to handle this intro.

*2.5s*

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

Great question, and good news: PeerTeach is completely free for pilot schools. It's covered by a grant this school year, so there's no cost to you at all.

I'd love to walk you through it on a quick 30-minute Zoom. Would any of these work?

- Today at 3:00 PM EDT
- Tomorrow at 2:00 PM EDT

Happy to find another time if those don't work.

-Katie
```

**Checks:** 69 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*17.8s*

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

Great to hear from you! Here are a couple of times that work for a quick 30-minute Zoom:

- Today at 3:00 PM EDT
- Tomorrow at 2:00 PM EDT

Happy to find another time if those don't work.

Kreg
Co-Founder, PeerTeach
```

**Checks:** 44 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*18.8s*

---

## 16. Prospect says "morning works better for me"
**Vague time preference — agent should find morning slots.**

**Prospect:** Jane Smith — Principal @ Jefferson Middle School, Denver CO
**Sending from:** katie@peerteach.com

**Their reply:** "Happy to hop on a call! Mornings work better for me though, before noon if possible."

**Action:** `draft`

**Draft reply:**
```
Hi Jane,

Great to hear! The slots I have available right now land right at noon your time:

- Tomorrow at 12:00 PM MDT
- This Monday at 12:00 PM MDT
- This Tuesday at 12:00 PM MDT

I know those are right on the edge of your preference. Happy to find another time if none of those work for you.

-Katie
```

**Checks:** 62 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*29.6s*

---

## 17. Prospect says "end of the week"
**Vague day preference — agent should propose Thursday or Friday.**

**Prospect:** Jane Smith — Principal @ Harbor View Elementary, Seattle WA
**Sending from:** katie@peerteach.com

**Their reply:** "Sure, I can chat. End of the week works best for me."

**Action:** `draft`

**Draft reply:**
```
Hi Jane,

Great, happy to connect! Here are a couple of options for a quick 30-minute Zoom:

- Tomorrow at 11:00 AM PDT
- This Friday at 11:00 AM PDT

Do either of those work for you? Happy to find another time if not.

-Katie
```

**Checks:** 45 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*17.1s*

---

## 18. Prospect says just "sure"
**Minimal reply showing interest but no details. Should propose times.**

**Prospect:** Jane Smith — Principal @ Riverside Academy, Atlanta GA
**Sending from:** katie@peerteach.com

**Their reply:** "Sure."

**Action:** `draft`

**Draft reply:**
```
Hi Jane,

Happy to set up a quick 30-minute Zoom. Do either of these work for you?

- Today at 3:00 PM EDT
- Tomorrow at 2:00 PM EDT

Happy to find another time if those don't work.

-Katie
```

**Checks:** 39 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*17.3s*

---

## 19. Prospect asks what PeerTeach actually does
**SOFT_YES — interested but wants more info before committing to a call.**

**Prospect:** Jane Smith — Principal @ Franklin Elementary, Portland OR
**Sending from:** katie@peerteach.com

**Their reply:** "This sounds interesting but can you tell me a bit more about how it actually works in the classroom? What does the teacher have to do?"

**Action:** `draft`

**Draft reply:**
```
Hi Jane,

Great question. Teachers don't need to prep anything extra , PeerTeach gives them ready-to-run session guides, and students work in structured pairs during regular class time. The teacher's role is more of a facilitator, circulating and checking in.

The easiest way to walk through it is on a quick 30-minute Zoom. Would today at 12:00 PM PDT or tomorrow at 11:00 AM PDT work? Happy to find another time if those don't work.

-Katie
```

**Checks:** 76 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*7.4s*

---

## 20. Prospect angry — too many emails
**Hostile but not an explicit unsubscribe. Should escalate.**

**Prospect:** Jane Smith — Principal @ Lincoln High School, Phoenix AZ
**Sending from:** katie@peerteach.com

**Their reply:** "I've gotten 4 emails from you guys in the past month. This is way too much. Stop."

**Action:** `hard_no`


*2.3s*

---

## 21. Prospect is the AP not the principal
**Still a relevant person — should treat as normal interest, not wrong person.**

**Prospect:** Jane Smith — Assistant Principal @ Sunrise Elementary, Miami FL
**Sending from:** katie@peerteach.com

**Their reply:** "Hi, I'm the assistant principal here. I handle instructional programs. Yes, I'd be happy to learn more!"

**Action:** `draft`

**Draft reply:**
```
Hi Jane,

Great to hear from you, and glad this landed with the right person! I'd love to set up a quick 30-minute Zoom to walk you through how PeerTeach works and what results we've seen at pilot schools.

Would either of these work?

- Today at 3:00 PM EDT
- Tomorrow at 2:00 PM EDT

Happy to find another time if those don't work.

-Katie
```

**Checks:** 66 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*22.8s*

---

## 22. Prospect wants to include their colleague
**Prospect asks if they can bring someone else to the call.**

**Prospect:** Jane Smith — Principal @ Central Middle School, Columbus OH
**Sending from:** katie@peerteach.com

**Their reply:** "Yes, I'd love to chat! Can I also include our math department head on the call?"

**Action:** `draft`

**Draft reply:**
```
Hi Jane,

So glad to hear it, and of course , the more the merrier! The math department head is very welcome on the call.

Here are a couple of times that work for a quick 30-minute Zoom:

- Today at 3:00 PM EDT
- Tomorrow at 2:00 PM EDT

Happy to find another time if those don't work for both of you.

-Katie
```

**Checks:** 64 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*17.4s*

---

## 23. Very long back-and-forth before confirming
**Multi-turn thread with 5 exchanges. Prospect finally confirms a time.**

**Prospect:** David Chen — Principal @ Eastside K-8, San Francisco CA
**Sending from:** katie@peerteach.com

<details><summary>Prior thread</summary>

**[Us]** Hi David, I wanted to share PeerTeach with you — free math peer tutoring for grades 3-8.

**[Prospect]** Interesting. Can you tell me more about how it works?

**[Us]** Hi David, happy to! It's a structured peer tutoring program that runs during regular class time — no extra prep for teachers. Developed at Stanford and completely free this year. Worth a quick Zoom?



**[Prospect]** What grade levels does it cover?

**[Us]** Hi David, grades 3-8, math. The Zoom would only be 20-30 minutes and I can walk you through exactly what it looks like. How does Wednesday, June 3 at 10:00 AM PDT or Thursday, June 4 at 2:00 PM PDT wo

**[Prospect]** I'm slammed this week. Maybe next week?

**[Us]** Hi David, no problem at all. Here are a couple of times next week:
- Monday, June 8 at 11:00 AM PDT
- Tuesday, June 9 at 10:00 AM PDT

Either of those work?

-Katie.

**[Prospect]** Okay fine, let's just do Tuesday at 10am.

</details>

**Their reply:** "Okay fine, let's just do Tuesday at 10am."

**Action:** `draft` (books on Send)

**Draft reply:**
```
Hi David,

Perfect, that works on my end. I just sent over a calendar invite with the Zoom link. Looking forward to connecting!

-Katie.
```

**Checks:** 24 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*9.8s*

---

## 24. Prospect replies to follow-up saying they already talked
**Prospect is confused — thinks they already had the call. Should escalate.**

**Prospect:** Jane Smith — Principal @ Willowbrook Elementary, Charlotte NC
**Sending from:** katie@peerteach.com

**Their reply:** "Didn't we already do this call? I spoke with someone from your team last month."

**Action:** `escalate`

**Escalate reason:** Prospect says she already had a call with someone on the team last month. Unclear if she's an existing user, already in the pipeline, or if the outreach was sent in error. Needs human to check CRM before responding.

*9.5s*

---

## 25. Prospect asks for "sometime next month"
**Far future request — agent should fetch slots for next month.**

**Prospect:** Jane Smith — Principal @ Oakwood Academy, Minneapolis MN
**Sending from:** katie@peerteach.com

**Their reply:** "Yes let's connect! Summer would be tough but I could do sometime in July."

**Action:** `draft`

**Draft reply:**
```
Hi Jane,

July works great! Here are a few options for a quick 30-minute Zoom:

- Wednesday, July 1 at 1:00 PM CDT
- Thursday, July 2 at 1:00 PM CDT
- Wednesday, July 8 at 1:00 PM CDT
- Thursday, July 9 at 1:00 PM CDT

Do any of those work for you? Happy to find another time if not.

-Katie
```

**Checks:** 62 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*25.8s*

---

## 26. Prospect won't attend, asks to invite CC'd colleagues
**Prospect confirms 1:30 but says he won't attend and CC's two colleagues, asking to invite them. Should book and add all CC'd recipients (and his second address) as guests automatically — not escalate.**

**Prospect:** Nick Reece — Principal @ Moultrie Middle, Charleston SC
**Sending from:** kreg@peerteach.us

<details><summary>Prior thread</summary>

**[Us]** Hi Nick, would tomorrow at 1:30 PM EDT or 4:30 PM EDT work for a quick 30-minute Zoom?

Kreg

**[Prospect]** Good morning, I have added Assistant Principal Ms. Richbourg and Instructional Coach Ms. Pond to this email. They can Zoom with you at 1:30 tomorrow, as I will be in another meeting. Please send them 

</details>

**Their reply:** "Good morning, I have added Assistant Principal Ms. Richbourg and Instructional Coach Ms. Pond to this email. They can Zoom with you at 1:30 tomorrow, as I will be in another meeting. Please send them a calendar invite. Thanks!"

**Action:** `escalate`

**Escalate reason:** Nick confirmed 1:30 PM EDT on June 9 (2026-06-09T17:30:00Z) for Ms. Richbourg and Ms. Pond to Zoom, but that time has already passed. Ms. Richbourg and Ms. Pond are CC'd on the thread. Human needs to follow up to reschedule with them.

*14.2s*

---
