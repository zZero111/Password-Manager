# Keyhold

A self-hosted, end-to-end encrypted password manager. People keep their secrets in a vault that only their own devices can decrypt; a server they run themselves keeps those devices in sync without being able to read anything.

## Language

### People and access

**Account**:
One person's identity on a Keyhold server, identified by an email address and unlocked by a master password. A server may hold several Accounts; Accounts share nothing.
_Avoid_: User, profile, login (that's an item type)

**Master password**:
The single secret a person remembers to unlock their Account. It cannot be reset or recovered.
_Avoid_: Password (ambiguous with a login's password), passcode

**Device**:
A signed-in installation of the app. The same physical machine can appear as more than one Device (e.g. two browsers, or signing in again).
_Avoid_: Session, client

**Account deletion**:
Permanently removing an Account and everything it stored from a Server; every one of its Devices is signed out.
_Avoid_: Close account, deactivate

**Move**:
Re-homing an Account onto a different Server using a Device's copy of the Vault, with the same Master password, optionally followed by Account deletion on the old Server.
_Avoid_: Migration, transfer, restore

**Server**:
The self-hosted service that stores encrypted vaults and relays changes between an Account's Devices. It can never read vault contents.
_Avoid_: Backend, cloud, sync service

### Device states

**Locked**:
The Device holds the vault but has forgotten the key; the master password is needed to read it. Works offline.
_Avoid_: Logged out, closed

**Disconnected**:
The Device still holds its vault and can be unlocked, but the Server no longer accepts it, so it can't sync until the person signs in again. Unsynced changes are kept.
_Avoid_: Signed out, expired, logged out

**Sign out**:
Removing a Device: its copy of the vault is erased and the Server stops accepting it. Done from another Device, it takes effect the next time the removed Device contacts the Server — which it does even while Locked; until then it keeps its encrypted copy.
_Avoid_: Log out, lock, disconnect, revoke

**Offline erase**:
A Device erasing its own copy of the vault after going a chosen number of days without reaching the Server. Off unless the person turns it on.
_Avoid_: Self-destruct, wipe, dead-man switch

### The vault

**Vault**:
Everything an Account stores — all of its Items, including those in the Trash.
_Avoid_: Database, safe, store

**Item**:
One stored secret record: a Login, a Card or a Secure note.
_Avoid_: Entry, cipher, record, credential

**Login**:
An Item holding a username, password, optional authenticator key and the websites it's for.
_Avoid_: Credential, account, password entry

**Card**:
An Item holding payment card details.
_Avoid_: Credit card, payment method

**Secure note**:
An Item holding free text (and optionally custom fields) only.
_Avoid_: Note, memo

**Folder**:
A label grouping Items. Each Item is in at most one Folder; a Folder exists only while some Item uses it. Names match ignoring case and surrounding spaces, and are shown as spelled on the most recently changed Item.
_Avoid_: Category, collection, tag, group

**Favourite**:
A flag that pins an Item to the top of lists.
_Avoid_: Starred, pinned

**Secret history**:
Previous values of an Item's secret fields (password, Authenticator key, card number and code, hidden fields), newest first, each labelled with its field. Includes every secret value that lost a Conflict.
_Avoid_: Password history (it holds more than passwords), versions

**Authenticator key**:
The secret a website gives when setting up two-factor authentication, from which the app shows rolling verification codes.
_Avoid_: TOTP secret, 2FA seed, OTP

**Verification code**:
The short-lived numeric code derived from an Authenticator key.
_Avoid_: TOTP, OTP, token

### Change and history

**Delete**:
Moving an Item to the Trash.
_Avoid_: Remove, trash (as a verb)

**Trash**:
Where deleted Items wait for 30 days, restorable, before being Purged. Emptying the Trash Purges everything in it.
_Avoid_: Bin, recycle bin, archive

**Purge**:
Permanently removing an Item from the Vault on every Device, either by hand or by whichever Device first finds it 30 days in the Trash.
_Avoid_: Delete permanently (UI label only), destroy

**Conflict**:
Two Devices changing the same Item before either has synced. The most recent change wins the whole Item; nothing is merged field by field, but the loser's secret values are kept in Secret history.
_Avoid_: Collision, merge

**Import**:
Adding Items to the Vault from another password manager's export file (Bitwarden JSON) or a Keyhold export.
_Avoid_: Migration, restore

**Export**:
Writing every Item outside the Trash to an unencrypted file the person controls.
_Avoid_: Backup (a Server backup holds only encrypted data)
