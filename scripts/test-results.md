# PeerTeach Agent — Test Results
**Run:** 2026-06-02T23:25:56.266Z
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

So glad it works for you! Here are a couple of times this week:

- Wednesday, June 3 at 2:00 PM EDT
- Thursday, June 4 at 2:00 PM EDT

Do either of those work for you?

-Katie.
```

**Checks:** 40 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*5.2s*

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

Next week works great. Here are a couple of open slots:

- Monday, June 8 at 1:00 PM CDT
- Tuesday, June 9 at 1:00 PM CDT

Do either of those work for you?

-Katie.
```

**Checks:** 37 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*5.1s*

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

Booked. Calendar invite is on its way. Looking forward to chatting Thursday, June 4 at 2:00 PM PDT!

-Katie.
```

**Checks:** 21 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*7.9s*

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

Thursday, June 4 at 3:00 PM CDT works perfectly. I'll send over a calendar invite shortly!

Looking forward to connecting.

-Katie.
```

**Checks:** 23 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*6.7s*

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

Booked. Calendar invite is on its way. Looking forward to chatting Thursday at 2:00 PM EDT?

-Katie.
```

**Checks:** 19 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*4.0s*

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


*2.2s*

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

So glad to hear it! I'd love to connect for a quick 20-30 min Zoom to walk you through how PeerTeach works and whether it'd be a good fit for Greenwood.

A couple of openings this week:

- Wednesday, June 3 at 11:00 AM PDT
- Thursday, June 4 at 11:00 AM PDT

Do either of those work for you?

-Katie.
```

**Checks:** 63 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*5.8s*

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

Two weeks out works great. Here are a couple of options:

- Tuesday, June 16 at 1:00 PM CDT
- Wednesday, June 17 at 1:00 PM CDT

It's just a 20-30 min Zoom call. Do either of those work for you?

-Katie.
```

**Checks:** 44 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*5.0s*

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

Totally understand, it sounds like you've already got things covered. Hope the rest of the school year goes smoothly, and feel free to reach out if anything changes down the road.

-Katie.
```

**Checks:** 34 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*1.9s*

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

Thanks for letting me know. Do you happen to know who the principal is or have their contact info so I can reach out directly?

-Katie.
```

**Checks:** 28 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*1.9s*

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

Thanks for the heads up. Do you happen to have Maria's direct email so I can reach out to her directly?

-Katie.
```

**Checks:** 24 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*1.6s*

---

## 13. Referral — gives direct email
**Prospect gives a direct email address. Should escalate to human to make the intro.**

**Prospect:** Jane Smith — Principal @ Lincoln Elementary
**Sending from:** katie@peerteach.com

**Their reply:** "You should contact our AP directly — her email is maria.gonzalez@school.edu"

**Action:** `escalate`

**Escalate reason:** Prospect provided a direct email address (maria.gonzalez@school.edu) for their AP — a human needs to handle this intro personally.

*2.9s*

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

It's a 20-30 min Zoom call to see if it's a fit. Would you have time this week or next to connect?

-Katie.
```

**Checks:** 44 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*2.4s*

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

Great, I'd love to connect! Here are a couple of times that work for a quick 20-30 min Zoom:

- Wednesday, June 3 at 2:00 PM EDT
- Thursday, June 4 at 2:00 PM EDT

Do either of those work for you?

Kreg
Co-Founder, PeerTeach
```

**Checks:** 47 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*5.1s*

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

Great, looking forward to it! The available slots I have are:

- Wednesday, June 3 at 12:00 PM MDT
- Thursday, June 4 at 12:00 PM MDT

Either of those work for you?

-Katie.
```

**Checks:** 36 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*6.6s*

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

Happy to connect! Here are a couple of times that work toward the end of the week:

- Thursday, June 4 at 11:00 AM PDT
- Friday, June 5 at 11:00 AM PDT

Just let me know which works for you and I'll send over a Zoom link.

-Katie.
```

**Checks:** 51 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*5.2s*

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

Happy to connect. Would either of these work for a quick 20-30 min Zoom?

- Wednesday, June 3 at 2:00 PM EDT
- Thursday, June 4 at 2:00 PM EDT

I know it's a busy time of year, so happy to find something that works for you.

-Katie.
```

**Checks:** 50 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*4.8s*

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

Great question. Here's how it works in practice:

- Teachers run short, structured peer tutoring sessions during regular class time (no extra time needed)
- PeerTeach provides the pairing logic, session guides, and progress tracking
- The teacher facilitates, but students lead the learning

It's designed to be low-lift for teachers. The best way to see it in action is a quick 20-30 min Zoom. Would you have time for that?

-Katie.
```

**Checks:** 74 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*4.2s*

---

## 20. Prospect angry — too many emails
**Hostile but not an explicit unsubscribe. Should escalate.**

**Prospect:** Jane Smith — Principal @ Lincoln High School, Phoenix AZ
**Sending from:** katie@peerteach.com

**Their reply:** "I've gotten 4 emails from you guys in the past month. This is way too much. Stop."

**Action:** `hard_no`


*1.5s*

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

So glad to hear it! PeerTeach is completely free for pilot schools this year, backed by a grant, and we've seen strong results at nearby schools. It's a quick 20-30 min Zoom to walk you through everything.

Do either of these work for a call?

- Wednesday, June 3 at 2:00 PM EDT
- Thursday, June 4 at 2:00 PM EDT

-Katie.
```

**Checks:** 64 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*5.0s*

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

Of course, bring your math department head along. The more the merrier.

Here are a couple of times that work for a 20-30 min Zoom:

- Wednesday, June 3 at 2:00 PM EDT
- Thursday, June 4 at 2:00 PM EDT

Do either of those work for you both?

-Katie.
```

**Checks:** 52 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*6.2s*

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

**Action:** `draft` (meeting booked)

**Draft reply:**
```
Hi David,

Booked. Calendar invite is on its way. Looking forward to chatting Tuesday at 10:00 AM PDT.

-Katie.
```

**Checks:** 19 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*5.8s*

---

## 24. Prospect replies to follow-up saying they already talked
**Prospect is confused — thinks they already had the call. Should escalate.**

**Prospect:** Jane Smith — Principal @ Willowbrook Elementary, Charlotte NC
**Sending from:** katie@peerteach.com

**Their reply:** "Didn't we already do this call? I spoke with someone from your team last month."

**Action:** `draft`

**Draft reply:**
```
Hi Jane,

Apologies for the confusion! It's possible a colleague reached out separately. I don't want to duplicate anyone's time. Could you share who you spoke with, or what was covered? That way I can make sure we're not stepping on each other's toes.

-Katie.
```

**Checks:** 45 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*3.6s*

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

July works great. Here are a couple of options to start:

- Wednesday, July 1 at 1:00 PM CDT
- Thursday, July 2 at 1:00 PM CDT

It's just a 20-30 min Zoom, and I'd love to show you what PeerTeach looks like in practice. Do either of those work for you?

-Katie.
```

**Checks:** 55 words ✓ | starts with Hi: ✓ | em dashes: ✓ none

*5.2s*

---
