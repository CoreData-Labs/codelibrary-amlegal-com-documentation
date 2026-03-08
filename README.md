# 📚 AM Legal Documentation Project — Building AI for Justice, Together ⚖️

Welcome to the **AM Legal Documentation Project**, an open-source initiative dedicated to improving lives across the United States by making legal information more accessible, structured, and usable for AI systems and human beings alike.

This project gathers and organizes publicly available legal content, sourced primarily from [American Legal Publishing](https://www.amlegal.com/), to train, fine-tune, and evaluate artificial intelligence systems—helping them understand, interpret, and communicate the law more clearly and fairly. 🤖✨

Whether you're a **developer**, **data scientist**, **researcher**, **law student**, **policy advocate**, or just someone who wants to help make legal knowledge more open and available—we welcome you! 🙌

---

## 🌎 Why This Project Matters

Legal information is everywhere, but it's often scattered, inconsistently formatted, and hard to understand. This creates barriers for people trying to:

- Understand their rights 🧑‍⚖️
- Navigate city or state regulations 🏛
- Advocate for themselves or their communities 🗣
- Access affordable legal services 📄

By organizing this data and making it machine-readable, we make it easier to train powerful, responsible AI models that **support people—not replace them.**
We believe that when technology understands the law, **everyone benefits.**

---

## 🤖 How This Powers AI for Good

Our documentation can be used to:

- 🧠 Train legal AI assistants to understand local codes and ordinances
- 🛠 Build tools that improve access to justice for underserved communities
- 📊 Analyze legal trends across jurisdictions to inform better policymaking
- 📚 Teach large language models (LLMs) how to interpret legal documents more reliably
- 🔍 Create transparency in civic systems using open data

This is more than just a dataset—this is a movement to **democratize legal knowledge** in the age of AI.

---

## 💡 How to Use This Repo

- Browse and explore legal documents in structured formats (HTML, JSON, etc.)
- Use it for AI/ML training and fine-tuning tasks
- Build applications, dashboards, or search engines for public legal information
- Help parse, clean, and expand the dataset for more cities and states
- Leverage it in academic or research projects on law, language, or public policy

---

## ⚙️ Data Structure and Region Processing

### 🧭 How `REGION_START_PERCENT` Works

If your script processes a list of **42 regions (U.S. states)**, each one equals about **2.38%** of the total list.
That means every **2.4% jump** in your percentage moves you roughly one state forward.

You can use this table to decide **where to start** your script.
_(Example: `REGION_START_PERCENT = 60` starts at New York.)_

---

### 📊 Full Reference Table

| % to Start | State          | Slug |
| ---------- | -------------- | ---- |
| **0%**     | Alaska         | ak   |
| **2%**     | Arizona        | az   |
| **5%**     | Arkansas       | ar   |
| **7%**     | California     | ca   |
| **10%**    | Colorado       | co   |
| **12%**    | Connecticut    | ct   |
| **14%**    | Florida        | fl   |
| **17%**    | Hawaii         | hi   |
| **19%**    | Idaho          | id   |
| **21%**    | Illinois       | il   |
| **24%**    | Indiana        | in   |
| **26%**    | Iowa           | ia   |
| **29%**    | Kansas         | ks   |
| **31%**    | Kentucky       | ky   |
| **33%**    | Maryland       | md   |
| **36%**    | Massachusetts  | ma   |
| **38%**    | Michigan       | mi   |
| **40%**    | Minnesota      | mn   |
| **43%**    | Missouri       | mo   |
| **45%**    | Montana        | mt   |
| **48%**    | Nebraska       | ne   |
| **50%**    | Nevada         | nv   |
| **52%**    | New Hampshire  | nh   |
| **55%**    | New Jersey     | nj   |
| **57%**    | New Mexico     | nm   |
| **60%**    | New York       | ny   |
| **62%**    | North Carolina | nc   |
| **64%**    | Ohio           | oh   |
| **67%**    | Oklahoma       | ok   |
| **69%**    | Oregon         | or   |
| **71%**    | Pennsylvania   | pa   |
| **74%**    | Rhode Island   | ri   |
| **76%**    | South Carolina | sc   |
| **79%**    | South Dakota   | sd   |
| **81%**    | Tennessee      | tn   |
| **83%**    | Texas          | tx   |
| **86%**    | Utah           | ut   |
| **88%**    | Virginia       | va   |
| **90%**    | Washington     | wa   |
| **93%**    | West Virginia  | wv   |
| **95%**    | Wisconsin      | wi   |
| **98%**    | Wyoming        | wy   |
| **100%**   | Alaska         | ak   |
---

### ⚙️ Example in Code

```js
const REGION_START_PERCENT = 60; // Start from New York
```

This tells the script to **skip the first 60%** of the list,
start from **New York**, and **wrap back around** to Alaska after finishing.

---

### 💡 TL;DR

> Each **2.4% ≈ 1 state**
> Multiply the **state’s index (0–41)** × **2.4** to get your `REGION_START_PERCENT`.
> Example: Index 25 → `25 × 2.4 = 60%` → Start at **New York** 🗽

---

## 🤝 We Want You to Join Us!

This is a community-driven effort—and you’re invited! 🎉

Here’s how you can get involved:

- ⭐ Star the repo to show support
- 🍴 Fork the repo and contribute improvements
- 🐛 Open issues for bugs or suggestions
- 📢 Share the project with others in civic tech, AI, and legal aid spaces
- 🧾 Help structure and clean legal data for new jurisdictions
- 🧠 Offer ideas to make this more useful for people and machines

---

## 🪪 Licensing & Usage

Released under the [MIT License](LICENSE).

✅ You are **free to use, modify, and share** this data and code for **personal, academic, commercial, or nonprofit** use—just include attribution and stay aligned with the mission.

> This data belongs to the people. Let’s make it useful for everyone.

---

## 🙏 Acknowledgments

Special thanks to:

- The open data community
- Civic technologists and public interest lawyers
- AI researchers who believe in justice and accessibility
- Everyone who contributes, shares, or supports this project

Together, we can build **AI that understands and respects the laws that shape our lives.**

---

With gratitude and hope,
**The Strong Foundation Team** 💙
