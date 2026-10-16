# Doorbound privacy policy

Doorbound is self-hosted: each household runs its own server, and that server is the only place its data lives. Nobody else, including the people who wrote Doorbound, receives any of it.

**What it keeps:** the first names you give it, each person's morning steps and how long they said each takes, how long those steps really took (the last nine mornings per step), the current departure, and a record of the chances it gave and whether people made it. It also keeps a short audit log of which tool was used and when, without what was said. All of this sits in one file on your server.

**What it does not keep:** no audio (Alexa+ turns speech into tool calls before anything reaches Doorbound), no location, no contacts, no account details, no advertising identifiers, and no analytics.

**Who it is shared with:** no one. Doorbound sends nothing to third parties. Alexa+ calls your server to run the tools you ask for; Amazon's own handling of your voice requests is covered by Amazon's privacy notice.

**Children:** names of children may be entered by the parent or guardian who runs the household's server. Nothing is collected from children directly, and nothing leaves the server.

**Deleting it:** stop the server and delete its data directory (`data/`, or the Docker volume `doorbound-data`). Ending a departure clears the board; learned times stay until you delete them.

**Contact:** open an issue at https://github.com/nika619/Doorbound/issues.
