## Default Permission

Allows the bundled NIHO app UI (the app's own frontendDist) to read the NIHO account state (profile without any token), start the browser login (opens the niho.life connect page in the default browser), cancel it, log out (revokes this Mac's connection and clears the saved sign-in file; with `everywhere` it first signs the account out on every device), and open My Page in the default browser. No token, code or verifier is ever returned to the page.

#### This default permission set includes the following:

- `allow-account-state`
- `allow-account-begin-login`
- `allow-account-cancel-login`
- `allow-account-logout`
- `allow-account-open-my-page`

## Permission Table

<table>
<tr>
<th>Identifier</th>
<th>Description</th>
</tr>


<tr>
<td>

`niho-desktop-account:allow-account-begin-login`

</td>
<td>

Enables the account_begin_login command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`niho-desktop-account:deny-account-begin-login`

</td>
<td>

Denies the account_begin_login command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`niho-desktop-account:allow-account-cancel-login`

</td>
<td>

Enables the account_cancel_login command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`niho-desktop-account:deny-account-cancel-login`

</td>
<td>

Denies the account_cancel_login command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`niho-desktop-account:allow-account-logout`

</td>
<td>

Enables the account_logout command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`niho-desktop-account:deny-account-logout`

</td>
<td>

Denies the account_logout command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`niho-desktop-account:allow-account-open-my-page`

</td>
<td>

Enables the account_open_my_page command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`niho-desktop-account:deny-account-open-my-page`

</td>
<td>

Denies the account_open_my_page command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`niho-desktop-account:allow-account-state`

</td>
<td>

Enables the account_state command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`niho-desktop-account:deny-account-state`

</td>
<td>

Denies the account_state command without any pre-configured scope.

</td>
</tr>
</table>
