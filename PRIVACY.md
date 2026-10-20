# Doorbound privacy policy

Doorbound is self-hosted: each household runs its own server, and that server is the only place its data lives. Nobody else, including the people who wrote Doorbound, receives any of it.

**What it keeps:** the first names you give it, each person's morning steps and how long they said each takes, how long those steps really took (the last nine mornings per step), the current departure, and a record of the chances it gave and whether people made it. It also keeps a short audit log of which tool was used and when, without what was said and without names: people and devices appear only as one-way hashes. All of this sits in one file per household on the server.

**What it does not keep:** no audio (Alexa+ turns speech into tool calls before anything reaches Doorbound), no location, no contacts, no account details, no advertising identifiers, and no analytics.

**Who it is shared with:** no one. Doorbound sends nothing to third parties. Alexa+ calls your server to run the tools you ask for; Amazon's own handling of your voice requests is covered by Amazon's privacy notice.

**Children:** Doorbound is used by parents and carers to run their household's morning; it is not directed to children. A child's first name and routine are entered by the parent or carer whose Alexa account is linked. Nothing is collected from children directly, there is no profiling and no advertising, and nothing leaves the server.

**Deleting it:** say "Alexa, delete everything Doorbound knows about us". After a yes, every routine, learned time, pace and kept score for your household is erased. A household nobody has used for 180 days is deleted automatically. Unlinking Doorbound in the Alexa app stops all access at once. The server's operator can also delete a household's folder, or the whole data directory.

**Contact:** open an issue at https://github.com/nika619/Doorbound/issues.
