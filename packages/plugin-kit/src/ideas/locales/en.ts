/**
 * The idea catalogue's words in English (the `ideas` namespace): each template's title, chip label, pitch and
 * the prompt it sends, keyed `ideas.<template key>.<field>`. `../catalogue.ts` reads its words from here.
 */
export const ideas = {
  "ideas.shopping.landed-cost.title": "I can compare a product's landed cost across stores",
  "ideas.shopping.landed-cost.label": "Compare landed cost",
  "ideas.shopping.landed-cost.pitch":
    "Tell me what you want to buy and I'll compare the price with shipping, duties and fees across the stores you use, in your own browser session.",
  "ideas.shopping.landed-cost.prompt":
    "Compare the full landed cost (price, shipping, duties, fees) of [product] across the stores I use, and tell me where it is cheapest delivered to me.",

  "ideas.shopping.review-check.title": "I can check whether a listing's reviews look genuine",
  "ideas.shopping.review-check.label": "Check a listing's reviews",
  "ideas.shopping.review-check.pitch":
    "Send me a product listing and I'll look for signs of fake reviews and knock-offs, and say how much to trust it.",
  "ideas.shopping.review-check.prompt":
    "Check this product listing for signs of fake reviews or a counterfeit, and tell me how far to trust it: [link]",

  "ideas.travel.specialist.title": "I can find a licensed specialist near you",
  "ideas.travel.specialist.label": "Find a licensed specialist",
  "ideas.travel.specialist.pitch":
    "Name the job and I'll search nearby specialists, check their state licence, and sum up their ratings so you can pick with confidence.",
  "ideas.travel.specialist.prompt":
    "Find a licensed [kind of specialist] near me, check each one's licence, and summarise their ratings and reviews.",

  "ideas.health-home.in-network.title": "I can find doctors in your insurance network",
  "ideas.health-home.in-network.label": "Find in-network care",
  "ideas.health-home.in-network.pitch":
    "Tell me your plan and what you need, and I'll list nearby providers who are in network and say which ones take new patients.",
  "ideas.health-home.in-network.prompt":
    "Find [kind of provider] near me who are in network for my [insurance plan], and tell me which ones accept new patients.",

  "ideas.work.job-watch.title": "I can watch job boards for roles that fit you",
  "ideas.work.job-watch.label": "Watch for matching jobs",
  "ideas.work.job-watch.pitch":
    "Give me the roles you want and your floor, and I'll search the boards, match openings to your résumé, and keep watching for new ones.",
  "ideas.work.job-watch.prompt":
    "Search job boards for [role] roles in [location or remote] paying at least [salary], and rank the openings against my résumé.",

  "ideas.work.application-prefill.title": "I can pre-fill a job application for you to check",
  "ideas.work.application-prefill.label": "Pre-fill an application",
  "ideas.work.application-prefill.pitch":
    "Point me at an application form and I'll fill it from your résumé, stop before submitting, and show you every answer to review.",
  "ideas.work.application-prefill.prompt":
    "Fill in this job application from my résumé, stop before the final submit, and show me each answer to check: [link]",

  "ideas.work.trend-radar.title": "I can watch a topic and tell you when it takes off",
  "ideas.work.trend-radar.label": "Watch a topic's trend",
  "ideas.work.trend-radar.pitch":
    "Name a topic and I'll track how fast it is rising across free sources, and tell you when the conversation speeds up.",
  "ideas.work.trend-radar.prompt": "How fast is [topic] trending across sources right now? Compare this week with the past month.",

  "ideas.work.comment-clusters.title": "I can sum up what people are saying in a thread",
  "ideas.work.comment-clusters.label": "Cluster the comments",
  "ideas.work.comment-clusters.pitch":
    "Send me a busy thread or comment page and I'll group what people are saying into themes, so you see the real arguments without the noise.",
  "ideas.work.comment-clusters.prompt": "Group the comments on this page into themes and tell me the main arguments on each side: [link]",

  "ideas.productivity.prospects.title": "I can research a company and who to talk to there",
  "ideas.productivity.prospects.label": "Research a prospect",
  "ideas.productivity.prospects.pitch":
    "Name a company and I'll map its teams and the public roles worth contacting, from sources it publishes itself.",
  "ideas.productivity.prospects.prompt":
    "Research [company]: what it does, how its teams are organised, and which public roles would be the right people to contact about [topic]. Use pages [company] publishes itself, link them, and name no person.",

  "ideas.travel.fare-watch.title": "I can watch flight prices for your next trip",
  "ideas.travel.fare-watch.label": "Watch flight prices",
  "ideas.travel.fare-watch.pitch":
    "Tell me the route and dates and I'll compare carriers now, then keep checking and tell you the fares each time.",
  "ideas.travel.fare-watch.prompt":
    "Find the cheapest flights from [origin] to [destination] around [dates], and compare carriers and fares.",

  "ideas.travel.hotels.title": "I can shortlist hotels from what guests actually say",
  "ideas.travel.hotels.label": "Shortlist hotels",
  "ideas.travel.hotels.pitch":
    "Give me the city, dates and what matters to you, and I'll sum up recent guest reviews into a shortlist with the trade-offs spelled out.",
  "ideas.travel.hotels.prompt":
    "Shortlist hotels in [city] for [dates] that fit [what matters to me], summarising what recent guests say about each.",

  "ideas.travel.car-or-rail.title": "I can weigh car rental against the train for a trip",
  "ideas.travel.car-or-rail.label": "Car or train?",
  "ideas.travel.car-or-rail.pitch":
    "Tell me the journey and I'll compare a rental with all its surcharges against the rail options, door to door.",
  "ideas.travel.car-or-rail.prompt":
    "For a trip from [A] to [B] on [date], compare renting a car (with all surcharges) against taking the train, door to door.",

  "ideas.travel.fuel-route.title": "I can plan fuel or charging stops on a road trip",
  "ideas.travel.fuel-route.label": "Plan fuel stops",
  "ideas.travel.fuel-route.pitch": "Give me the route and I'll find fuel or charging stops along it, with prices where the data exists.",
  "ideas.travel.fuel-route.prompt": "Plan fuel or EV charging stops for a drive from [A] to [B], with prices where available.",

  "ideas.travel.itinerary.title": "I can plan a day in a city around what you like",
  "ideas.travel.itinerary.label": "Plan a city day",
  "ideas.travel.itinerary.pitch":
    "Name the city and what you enjoy, and I'll build a day that groups nearby sights and places to eat, with your diet in mind.",
  "ideas.travel.itinerary.prompt": "Plan a day in [city] around [interests], grouping nearby sights and places to eat that suit [diet].",

  "ideas.travel.visa-packing.title": "I can check visa rules and build your packing list",
  "ideas.travel.visa-packing.label": "Check visa and packing",
  "ideas.travel.visa-packing.pitch":
    "Tell me where and when you're going and I'll check entry rules for your passport, list what to pack, and remind you of deadlines.",
  "ideas.travel.visa-packing.prompt":
    "I'm travelling to [country] on [dates] with a [nationality] passport. Check the entry and visa rules, build a packing list, and set reminders for any deadlines.",

  "ideas.learning.sketch-critique.title": "I can critique your drawing the way a teacher would",
  "ideas.learning.sketch-critique.label": "Critique my drawing",
  "ideas.learning.sketch-critique.pitch":
    "Send me a picture of a piece and I'll ask what you were going for, then give specific, honest notes on anatomy, perspective and values.",
  "ideas.learning.sketch-critique.prompt":
    "Here is a photo of my drawing. Ask me what I was aiming for, then critique its anatomy, perspective and values honestly.",

  "ideas.learning.garden-plan.title": "I can plan your garden beds for your climate",
  "ideas.learning.garden-plan.label": "Plan my garden",
  "ideas.learning.garden-plan.pitch":
    "Tell me your area and bed sizes and I'll check your hardiness zone, suggest companion plantings and draw up a sowing calendar.",
  "ideas.learning.garden-plan.prompt":
    "Plan my garden: I'm in [location] with [bed sizes]. Check my hardiness zone, suggest companion plantings, and give me a sowing calendar.",

  "ideas.health-home.fridge-recipes.title": "I can turn what's in your fridge into dinner",
  "ideas.health-home.fridge-recipes.label": "Cook from my fridge",
  "ideas.health-home.fridge-recipes.pitch":
    "Send me a picture of your fridge or a list, and I'll suggest recipes that use what's about to go off first.",
  "ideas.health-home.fridge-recipes.prompt":
    "Here's what's in my fridge: [list or photo]. Suggest recipes that use up what will spoil first.",

  "ideas.learning.mix-practice.title": "I can build you a practice plan for your instrument",
  "ideas.learning.mix-practice.label": "Plan my practice",
  "ideas.learning.mix-practice.pitch":
    "Tell me your instrument, level and goal and I'll set a weekly practice routine, or help diagnose what's muddying a mix.",
  "ideas.learning.mix-practice.prompt": "Build me a weekly practice plan for [instrument] at [level], aiming for [goal].",

  "ideas.productivity.photo-organise.title": "I can rename and sort a folder of photos by date and place",
  "ideas.productivity.photo-organise.label": "Sort my photos",
  "ideas.productivity.photo-organise.pitch":
    "Attach a photo folder and I'll rename and file the pictures from their EXIF data, after showing you the plan.",
  "ideas.productivity.photo-organise.prompt":
    "Rename and sort the photos in my attached folder by the date and place in their EXIF data. Show me the plan before moving anything.",

  "ideas.learning.cut-list.title": "I can work out the cut list for your next build",
  "ideas.learning.cut-list.label": "Make a cut list",
  "ideas.learning.cut-list.pitch": "Give me the parts and board sizes and I'll lay out the cuts to waste as little wood as possible.",
  "ideas.learning.cut-list.prompt": "Work out a cut list for these parts [list] from [board sizes], wasting as little as possible.",

  "ideas.learning.canon-audit.title": "I can check your manuscript for continuity slips",
  "ideas.learning.canon-audit.label": "Check my manuscript",
  "ideas.learning.canon-audit.pitch":
    "Attach your manuscript and I'll list contradictions in names, dates, places and rules of your world, chapter by chapter.",
  "ideas.learning.canon-audit.prompt":
    "Read the manuscript in my attached folder and list any continuity contradictions (names, dates, places, world rules), by chapter.",

  "ideas.productivity.morning-brief.title": "I can brief you on your day",
  "ideas.productivity.morning-brief.label": "Brief me on my day",
  "ideas.productivity.morning-brief.pitch": "I can sum up your meetings, the emails that need you and anything due, in one short read.",
  "ideas.productivity.morning-brief.prompt": "Give me a brief of today: my meetings, emails that need a reply, and anything due.",

  "ideas.productivity.meeting-slots.title": "I can find a meeting time across time zones",
  "ideas.productivity.meeting-slots.label": "Find a meeting time",
  "ideas.productivity.meeting-slots.pitch":
    "Tell me who and where they are, and I'll find slots that work in every time zone, or tell you plainly when none do.",
  "ideas.productivity.meeting-slots.prompt":
    "Find a [length] meeting slot next week that works for people in [time zones], checking my calendar.",

  "ideas.productivity.inbox-triage.title": "I can triage your inbox and draft the replies",
  "ideas.productivity.inbox-triage.label": "Triage my inbox",
  "ideas.productivity.inbox-triage.pitch":
    "I'll sort what needs you from what can wait and draft replies for you to check. Nothing is sent without you.",
  "ideas.productivity.inbox-triage.prompt":
    "Triage my inbox: tell me what needs me today, what can wait, and draft replies for the ones that need an answer.",

  "ideas.productivity.downloads-cleanup.title": "I can tidy a messy folder into a clear structure",
  "ideas.productivity.downloads-cleanup.label": "Tidy a folder",
  "ideas.productivity.downloads-cleanup.pitch":
    "Attach a cluttered folder and I'll propose a structure, then move things only after you approve the plan.",
  "ideas.productivity.downloads-cleanup.prompt":
    "Look through my attached folder, propose a clean folder structure, and wait for my OK before moving anything.",

  "ideas.productivity.subscriptions.title": "I can find subscriptions to cancel and stage the cancellation",
  "ideas.productivity.subscriptions.label": "Audit subscriptions",
  "ideas.productivity.subscriptions.pitch":
    "Tell me what you pay for and I'll flag what you barely use, then walk the cancellation flow with you, stopping before the final click.",
  "ideas.productivity.subscriptions.prompt":
    "Help me audit my subscriptions: [list]. Flag the ones worth cancelling and stage each cancellation, stopping before the final step, and say when each plan would end.",

  "ideas.health-home.appliance-records.title": "I can keep your appliance manuals and service dates",
  "ideas.health-home.appliance-records.label": "Track appliance upkeep",
  "ideas.health-home.appliance-records.pitch":
    "Send me a model or serial number and I'll find the manual, note the warranty, and remind you when maintenance is due.",
  "ideas.health-home.appliance-records.prompt":
    "Find the manual for my [appliance, model or serial], note its warranty, and set reminders for its maintenance.",

  "ideas.learning.tutor.title": "I can tutor you through a subject, step by step",
  "ideas.learning.tutor.label": "Tutor me",
  "ideas.learning.tutor.pitch":
    "Pick a topic and I'll teach it Socratically, asking questions until it clicks, instead of handing you the answer.",
  "ideas.learning.tutor.prompt": "Tutor me in [topic] Socratically: ask me questions and guide me rather than giving me the answers.",

  "ideas.learning.language.title": "I can role-play real situations in the language you're learning",
  "ideas.learning.language.label": "Practise a language",
  "ideas.learning.language.pitch":
    "Choose a situation, like ordering dinner or a job interview, and I'll play the other side in your target language and correct you gently.",
  "ideas.learning.language.prompt": "Role-play [situation] with me in [language] at [level], and correct my mistakes as we go.",

  "ideas.learning.flashcards.title": "I can turn what you read into flashcards",
  "ideas.learning.flashcards.label": "Make flashcards",
  "ideas.learning.flashcards.pitch":
    "Send me a book chapter or article and I'll distil its key ideas into spaced-repetition cards you can import into Anki.",
  "ideas.learning.flashcards.prompt": "Turn this [chapter or article] into Anki flashcards covering its key ideas: [file or link]",

  "ideas.learning.tech-roadmap.title": "I can map out what to learn next in tech",
  "ideas.learning.tech-roadmap.label": "Plan my learning path",
  "ideas.learning.tech-roadmap.pitch":
    "Tell me where you are and where you want to be, and I'll lay out a roadmap with resources, or untangle a stack trace with you.",
  "ideas.learning.tech-roadmap.prompt":
    "Lay out a learning roadmap from [where I am] to [goal]. Search the web for good free resources for each step, and link each one.",

  "ideas.learning.exam-prep.title": "I can find your weak spots before an exam",
  "ideas.learning.exam-prep.label": "Prep for an exam",
  "ideas.learning.exam-prep.pitch":
    "Name the exam and I'll quiz you to map where you're weak, then plan your study time around those areas.",
  "ideas.learning.exam-prep.prompt":
    "Help me prepare for [exam] on [date]: quiz me to find my weak areas, then plan study sessions with reminders.",

  "ideas.health-home.form-check.title": "I can coach your lifting form from a video",
  "ideas.health-home.form-check.label": "Check my form",
  "ideas.health-home.form-check.pitch":
    "Send me a clip of a lift and I'll describe what I see in your technique and setup, in words. It's coaching, not medical advice.",
  "ideas.health-home.form-check.prompt": "Here's a video of my [exercise]. Coach me on my technique and setup.",

  "ideas.health-home.meal-plan.title": "I can plan a week of meals around your goals",
  "ideas.health-home.meal-plan.label": "Plan my meals",
  "ideas.health-home.meal-plan.pitch":
    "Tell me your goals and what you like, and I'll plan a week of meals and one shopping list that wastes little.",
  "ideas.health-home.meal-plan.prompt":
    "Plan a week of meals for [goal] that I'll enjoy, with one shopping list that wastes as little as possible.",

  "ideas.health-home.sleep.title": "I can help you build a better sleep routine",
  "ideas.health-home.sleep.label": "Improve my sleep",
  "ideas.health-home.sleep.pitch":
    "Share your recent bedtimes and wake times and I'll suggest a routine to try. If anything worries you, see a doctor.",
  "ideas.health-home.sleep.prompt": "Here are my sleep times for the last week: [times]. Suggest a routine to try.",

  "ideas.health-home.thought-record.title": "I can walk you through a thought record when things feel heavy",
  "ideas.health-home.thought-record.label": "Reflect with me",
  "ideas.health-home.thought-record.pitch":
    "When something's bothering you, I can guide a short written reflection: what happened, what you thought, and a kinder way to see it.",
  "ideas.health-home.thought-record.prompt": "Walk me through a thought record about [situation].",

  "ideas.health-home.supplements.title": "I can set up reminders for your supplements",
  "ideas.health-home.supplements.label": "Remind me of supplements",
  "ideas.health-home.supplements.pitch":
    "List what you take and I'll set reminders and flag known timing clashes. Your pharmacist has the final say.",
  "ideas.health-home.supplements.prompt":
    "Set reminders for my supplements [list]. Search the web for known timing clashes between them, and give your sources.",

  "ideas.health-home.rental-watch.title": "I can watch rental listings that match what you want",
  "ideas.health-home.rental-watch.label": "Watch rental listings",
  "ideas.health-home.rental-watch.pitch":
    "Tell me your area, budget and must-haves and I'll check the listings regularly and tell you what matches.",
  "ideas.health-home.rental-watch.prompt": "Watch rental listings in [area] under [budget] with [must-haves], and tell me what matches.",

  "ideas.health-home.load-shift.title": "I can shift your appliances to cheaper off-peak hours",
  "ideas.health-home.load-shift.label": "Shift energy use",
  "ideas.health-home.load-shift.pitch":
    "I can look at your Home Assistant devices and tariff and suggest when to run what. Nothing changes until you approve it.",
  "ideas.health-home.load-shift.prompt":
    "Look at my Home Assistant devices and my tariff [details], and suggest which loads to shift to off-peak hours.",

  "ideas.health-home.recycling.title": "I can tell you which bin something goes in",
  "ideas.health-home.recycling.label": "Which bin?",
  "ideas.health-home.recycling.pitch":
    "Send me a picture of an item and I'll check your council's recycling rules and tell you where it goes.",
  "ideas.health-home.recycling.prompt": "Which bin does this go in where I live in [city]? [photo or description]",

  "ideas.health-home.neighbourhood.title": "I can profile a neighbourhood before you move",
  "ideas.health-home.neighbourhood.label": "Profile a neighbourhood",
  "ideas.health-home.neighbourhood.pitch":
    "Give me an address and I'll report on amenities, transport and noise sources nearby, from open data.",
  "ideas.health-home.neighbourhood.prompt":
    "Profile the neighbourhood around [address]: amenities, transport, schools and noise sources. Use the Places app, not a web search.",

  "ideas.health-home.school-forms.title": "I can fill in school forms for you to check",
  "ideas.health-home.school-forms.label": "Fill a school form",
  "ideas.health-home.school-forms.pitch":
    "Send me the form and I'll fill what I know, mark what's missing, and hand it back for you to check before it goes anywhere.",
  "ideas.health-home.school-forms.prompt":
    "Fill in this school form from what you know about my child, and mark anything you're missing: [file]",

  "ideas.people.carpool.title": "I can coordinate a carpool in your group chat",
  "ideas.people.carpool.label": "Organise a carpool",
  "ideas.people.carpool.pitch": "In your parents' group chat I can run a poll for pickups and read back who drives when.",
  "ideas.people.carpool.prompt": "Set up a pickup rota poll for [activity] in our group chat for the next [weeks].",

  "ideas.health-home.pet-vaccines.title": "I can track your pet's vaccines before boarding",
  "ideas.health-home.pet-vaccines.label": "Check pet vaccines",
  "ideas.health-home.pet-vaccines.pitch":
    "Send me the vet record and the kennel's rules and I'll check what's due, and remind you before anything lapses.",
  "ideas.health-home.pet-vaccines.prompt":
    "Check my pet's vaccine record [file] against the boarding rules of [kennel], and remind me before anything lapses.",

  "ideas.health-home.pet-diet.title": "I can stage your pet's switch to a new food",
  "ideas.health-home.pet-diet.label": "Switch pet food",
  "ideas.health-home.pet-diet.pitch": "I'll plan a gradual changeover day by day, remind you of each step, and help you log any symptoms.",
  "ideas.health-home.pet-diet.prompt":
    "Plan a gradual switch of my [pet] from [old food] to [new food], with daily reminders and a symptom log.",

  "ideas.health-home.lost-pet.title": "I can help search shelters if your pet goes missing",
  "ideas.health-home.lost-pet.label": "Lost pet search",
  "ideas.health-home.lost-pet.pitch":
    "If a pet goes missing I can draft the posts and search public pages for nearby shelters' found-pet listings.",
  "ideas.health-home.lost-pet.prompt":
    "My [pet] is missing near [area]. Draft a lost-pet post, and search public pages for nearby shelters' found-pet listings. Say only what you found, and that you can't see a shelter's own records.",

  "ideas.travel.car-code.title": "I can decode your car's warning code",
  "ideas.travel.car-code.label": "Decode a car code",
  "ideas.travel.car-code.pitch":
    "Give me the code and your car model and I'll explain the likely causes, the risk of driving on, and the part numbers.",
  "ideas.travel.car-code.prompt":
    "My [car model and year] shows code [code]. Explain the likely causes, whether it's safe to drive, and the part numbers.",

  "ideas.travel.bike-wear.title": "I can track your bike's wear and service intervals",
  "ideas.travel.bike-wear.label": "Track bike wear",
  "ideas.travel.bike-wear.pitch": "Tell me how far you ride and I'll tell you when the chain, cassette and pads are due for a check.",
  "ideas.travel.bike-wear.prompt":
    "Help me track wear on my bike: I ride about [distance] a week. Tell me when the chain, cassette and pads are due.",

  "ideas.travel.recalls.title": "I can watch for safety recalls on your car",
  "ideas.travel.recalls.label": "Watch car recalls",
  "ideas.travel.recalls.pitch": "Tell me your make, model and year and I'll check for open recalls regularly.",
  "ideas.travel.recalls.prompt": "Check for open safety recalls on my [make, model, year].",

  "ideas.shopping.capsule.title": "I can build a capsule wardrobe from what you own",
  "ideas.shopping.capsule.label": "Build a capsule wardrobe",
  "ideas.shopping.capsule.pitch":
    "Send pictures or a list of your clothes and I'll build outfits that mix and match, and name the one or two pieces worth adding.",
  "ideas.shopping.capsule.prompt":
    "Build a capsule wardrobe from these clothes [photos or list], and tell me which one or two pieces to add.",

  "ideas.shopping.outfit.title": "I can suggest an outfit for your day's weather and plans",
  "ideas.shopping.outfit.label": "Suggest today's outfit",
  "ideas.shopping.outfit.pitch": "Each morning I can match the forecast and your calendar to something from your wardrobe.",
  "ideas.shopping.outfit.prompt": "Suggest an outfit for today from my wardrobe, based on the weather and what's on my calendar.",

  "ideas.shopping.mending.title": "I can show you how to mend a garment, or where to sell it",
  "ideas.shopping.mending.label": "Mend or resell",
  "ideas.shopping.mending.pitch": "Send a picture and I'll walk you through the repair, or price it for resale.",
  "ideas.shopping.mending.prompt": "Here's a picture of [garment]. How do I mend it, or what could I resell it for?",

  "ideas.learning.dnd-lore.title": "I can keep your campaign's lore straight",
  "ideas.learning.dnd-lore.label": "Track campaign lore",
  "ideas.learning.dnd-lore.pitch":
    "After each session tell me what happened and I'll keep the world's state, NPCs and open threads ready for next time.",
  "ideas.learning.dnd-lore.prompt":
    "Here's what happened in our last [campaign] session: [notes]. Update the world state and list the open threads.",

  "ideas.learning.rules.title": "I can settle a board-game rules argument",
  "ideas.learning.rules.label": "Settle a rules question",
  "ideas.learning.rules.pitch":
    "Give me the game and the dispute, plus the rulebook if you have it, and I'll quote the rule that decides it.",
  "ideas.learning.rules.prompt": "In [game], [the dispute]. What do the rules say? [rulebook file, if any]",

  "ideas.people.game-night.title": "I can find a game night that suits your group",
  "ideas.people.game-night.label": "Plan a game night",
  "ideas.people.game-night.pitch": "In your group's chat I can poll for a date and suggest games to try.",
  "ideas.people.game-night.prompt": "Poll our group chat for a game night next week, and suggest co-op games we all own.",

  "ideas.learning.cursive.title": "I can transcribe an old handwritten document",
  "ideas.learning.cursive.label": "Transcribe a document",
  "ideas.learning.cursive.pitch": "Send a scan of a letter or record and I'll transcribe it carefully, marking the words I'm unsure of.",
  "ideas.learning.cursive.prompt": "Transcribe this handwritten document and mark any words you're unsure of: [image]",

  "ideas.learning.census.title": "I can trace an ancestor through census records",
  "ideas.learning.census.label": "Trace an ancestor",
  "ideas.learning.census.pitch":
    "Give me a name, place and rough dates and I'll follow them across censuses, in your own session on the archive.",
  "ideas.learning.census.prompt":
    "Trace [ancestor's name], born around [year] in [place], through the census records, with each record's link and how sure each match is.",

  "ideas.learning.gedcom.title": "I can check your family tree for impossible dates",
  "ideas.learning.gedcom.label": "Audit my family tree",
  "ideas.learning.gedcom.pitch":
    "Attach your GEDCOM file and I'll flag impossible dates and relationships, like parents younger than their children.",
  "ideas.learning.gedcom.prompt": "Check the GEDCOM file in my attached folder for impossible dates and relationships.",

  "ideas.productivity.note-links.title": "I can suggest links between your notes",
  "ideas.productivity.note-links.label": "Link my notes",
  "ideas.productivity.note-links.pitch": "Attach your notes vault and I'll suggest connections between related notes for you to accept.",
  "ideas.productivity.note-links.prompt": "Look through the notes in my attached folder and suggest links between related notes.",

  "ideas.productivity.distil.title": "I can distil an article down to what matters",
  "ideas.productivity.distil.label": "Distil an article",
  "ideas.productivity.distil.pitch":
    "Send me something long and I'll summarise it in layers, from key points to one line, so you keep what matters.",
  "ideas.productivity.distil.prompt": "Distil this into key points, then a paragraph, then one line: [link or file]",

  "ideas.productivity.bookmarks.title": "I can rescue the bookmarks you never got back to",
  "ideas.productivity.bookmarks.label": "Rescue my bookmarks",
  "ideas.productivity.bookmarks.pitch":
    "Give me your bookmarks export and I'll find dead links in the archive, group what's left and pick the ones worth reading.",
  "ideas.productivity.bookmarks.prompt":
    "Go through my bookmarks export in the attached folder: recover dead links from the archive, group the rest, and pick the best to read.",

  "ideas.people.recommendations.title": "I can recommend books and films from what you love",
  "ideas.people.recommendations.label": "Recommend something",
  "ideas.people.recommendations.pitch": "Tell me a few things you loved and I'll recommend across genres, explaining each pick in a line.",
  "ideas.people.recommendations.prompt": "Based on [books, films or shows I loved], recommend what to read or watch next and why.",

  "ideas.people.tour-radar.title": "I can tell you when your favourite artists play nearby",
  "ideas.people.tour-radar.label": "Watch for concerts",
  "ideas.people.tour-radar.pitch":
    "List the artists you love and your city, and I'll watch for tour dates and remind you before tickets go on sale.",
  "ideas.people.tour-radar.prompt": "Watch for tour dates near [city] for [artists], and remind me before tickets go on sale.",

  "ideas.people.keep-in-touch.title": "I can nudge you to keep in touch with people you care about",
  "ideas.people.keep-in-touch.label": "Keep in touch",
  "ideas.people.keep-in-touch.pitch":
    "Tell me who you'd like to stay close to and how often, and I'll remind you, with something to talk about.",
  "ideas.people.keep-in-touch.prompt":
    "Help me keep in touch with [people]: remind me each [weekday or day of the month] and suggest something to talk about.",
} as const;
