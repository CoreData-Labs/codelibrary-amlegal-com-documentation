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

## 🧑‍💻 How to Use This Repo via Git

You can also grab the project directly with Git:

```bash
# Clone the repository
git clone https://github.com/CoreData-Labs/codelibrary-amlegal-com-documentation.git

# Move into the project directory
cd codelibrary-amlegal-com-documentation

# Stay up to date with the latest changes
git pull origin main
```

### Running the scraper

The project uses a headless Chrome instance driven by `main.js`, so you'll need Chrome and a virtual display installed:

```bash
# Install a virtual framebuffer and Google Chrome
sudo apt-get install -y xvfb google-chrome-stable

# Install Node dependencies
npm install

# Run the scraper under a virtual display
xvfb-run -a node main.js
```

If you'd like to contribute back:

```bash
# Create a new branch for your changes
git checkout -b my-contribution

# Stage and commit your changes
git add .
git commit -m "Describe your changes here"

# Push your branch and open a Pull Request
git push origin my-contribution
```

---

## ⚙️ Data Structure and Region Processing

### 🧭 How `REGION_START_PERCENT` Works

If your script processes a list of **43 regions**, each one is spaced about **2.38%** apart across the full 0–100% range.
That means every **~2.4% jump** in your percentage moves you roughly one state forward, ending at Wyoming (100%).

You can use this table to decide **where to start** your script.
_(Example: `REGION_START_PERCENT = 62` starts at New York.)_

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
| **33%**    | Louisiana      | la   |
| **36%**    | Maryland       | md   |
| **38%**    | Massachusetts  | ma   |
| **40%**    | Michigan       | mi   |
| **43%**    | Minnesota      | mn   |
| **45%**    | Missouri       | mo   |
| **48%**    | Montana        | mt   |
| **50%**    | Nebraska       | ne   |
| **52%**    | Nevada         | nv   |
| **55%**    | New Hampshire  | nh   |
| **57%**    | New Jersey     | nj   |
| **60%**    | New Mexico     | nm   |
| **62%**    | New York       | ny   |
| **64%**    | North Carolina | nc   |
| **67%**    | Ohio           | oh   |
| **69%**    | Oklahoma       | ok   |
| **71%**    | Oregon         | or   |
| **74%**    | Pennsylvania   | pa   |
| **76%**    | Rhode Island   | ri   |
| **79%**    | South Carolina | sc   |
| **81%**    | South Dakota   | sd   |
| **83%**    | Tennessee      | tn   |
| **86%**    | Texas          | tx   |
| **88%**    | Utah           | ut   |
| **90%**    | Virginia       | va   |
| **93%**    | Washington     | wa   |
| **95%**    | West Virginia  | wv   |
| **98%**    | Wisconsin      | wi   |
| **100%**   | Wyoming        | wy   |

---

### ⚙️ Example in Code

```js
const REGION_START_PERCENT = 62; // Start from New York
```

This tells the script to **skip the first 62%** of the list
and start from **New York**, continuing through to Wyoming (100%).

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
