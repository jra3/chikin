// Goal suites for achieve.mjs (#103, #105).
//
// Every goal names its start page, the goal text, and a `check` that reads the
// PAGE (through `probe`, which runs upstream evaluate_script on the selected
// page) or the final URL. The model's DONE is never taken as evidence. `want`
// is the status the loop should end with. `limit` marks a goal the design is
// known not to handle (frames, shadow DOM, JavaScript dialogs, password
// fields); those report what happened but do not fail the run.

export const SUITES = {
  basic: [
    {
      name: "wikipedia search",
      start: "https://en.wikipedia.org/wiki/Main_Page",
      goal: 'Search Wikipedia for "Alan Turing" and open his article.',
      want: "done",
      check: async ({ url }) => /\/wiki\/Alan_Turing/.test(url),
    },
    {
      name: "hn past",
      start: "https://news.ycombinator.com/",
      goal: 'Open the "past" page of Hacker News.',
      want: "done",
      check: async ({ url }) => /\/front/.test(url),
    },
    {
      name: "pizza order",
      start: "https://httpbin.org/forms/post",
      goal: 'Order a pizza: customer name "Ada Test", telephone "555-0100", size Medium, topping Bacon, then submit the order.',
      want: "needs_confirmation",
      check: async ({ probe }) =>
        (await probe(
          "const f=document.forms[0]; return f.custname.value==='Ada Test' && f.custtel.value==='555-0100' && f.size.value==='medium' && [...f.topping].some(t=>t.value==='bacon'&&t.checked);",
        )) === true,
    },
  ],

  hard: [
    {
      name: "wikipedia two hops",
      start: "https://en.wikipedia.org/wiki/Main_Page",
      goal: 'Search Wikipedia for "Ada Lovelace", open her article, then open the article about her father, Lord Byron.',
      want: "done",
      check: async ({ url }) => /\/wiki\/Lord_Byron/.test(url),
    },
    {
      name: "native dropdown",
      start: "https://the-internet.herokuapp.com/dropdown",
      goal: "Select Option 2 in the dropdown list.",
      want: "done",
      check: async ({ probe }) => (await probe("return document.querySelector('#dropdown').value;")) === "2",
    },
    {
      name: "checkboxes, one already set",
      start: "https://the-internet.herokuapp.com/checkboxes",
      goal: "Make sure both checkboxes are checked.",
      want: "done",
      check: async ({ probe }) =>
        (await probe("return [...document.querySelectorAll('#checkboxes input')].every(c=>c.checked);")) === true,
    },
    {
      name: "wait for async content",
      start: "https://the-internet.herokuapp.com/dynamic_loading/1",
      goal: 'Start the loading and wait until the hidden text appears. You are done when "Hello World!" is visible.',
      want: "done",
      check: async ({ probe }) =>
        (await probe("const f=document.querySelector('#finish'); return !!f && f.offsetParent!==null && f.innerText.includes('Hello World!');")) ===
        true,
    },
    {
      name: "category browse",
      start: "https://books.toscrape.com/",
      goal: 'Open the Poetry category and then open the book "Olio".',
      want: "done",
      check: async ({ url }) => /olio/i.test(url),
    },
    {
      name: "cart and checkout",
      start: "https://www.saucedemo.com/",
      // Password fields are never offered to the loop (snapshot.js skips
      // them), so the login happens here and the goal starts at the inventory.
      setup: async ({ probe }) =>
        probe(
          "const set=(s,v)=>{const e=document.querySelector(s); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,v); e.dispatchEvent(new Event('input',{bubbles:true}));}; set('#user-name','standard_user'); set('#password','secret_sauce'); document.querySelector('#login-button').click(); return true;",
        ),
      goal: 'Add the "Sauce Labs Backpack" to the cart, go to the cart, check out with first name "Ada", last name "Test", postal code "12345", and complete the order.',
      want: "needs_confirmation",
      check: async ({ url, proposed }) => /checkout-step-two/.test(url) && /finish/i.test(proposed?.label ?? ""),
    },
    {
      name: "large form",
      start: "https://demoqa.com/automation-practice-form",
      goal: 'Fill the student registration form: first name "Ada", last name "Test", email "ada@example.com", gender Female, mobile "5550100200", then submit it.',
      want: "needs_confirmation",
      check: async ({ probe }) =>
        (await probe(
          "const v=s=>document.querySelector(s)?.value; return v('#firstName')==='Ada' && v('#lastName')==='Test' && v('#userEmail')==='ada@example.com' && v('#userNumber')==='5550100200' && document.querySelector('#gender-radio-2').checked;",
        )) === true,
    },
    {
      // the-internet's /shadowdom page slots its visible text from the regular
      // DOM, so it cannot tell a traversing snapshot from one that is not. The
      // Polymer shop renders its controls inside shadow roots.
      name: "shadow DOM controls",
      limit: "shadow DOM is not traversed",
      start: "https://shop.polymer-project.org/",
      goal: "Open the Men's Outerwear category.",
      want: "done",
      check: async ({ url }) => /mens_outerwear/.test(url),
    },
    {
      name: "iframe editor",
      limit: "frames are not traversed",
      start: "https://the-internet.herokuapp.com/iframe",
      goal: 'Replace the text in the editor with "hello chikin".',
      want: "done",
      check: async ({ probe }) =>
        (await probe("return document.querySelector('iframe')?.contentDocument?.body?.innerText?.includes('hello chikin') ?? false;")) === true,
    },
    {
      name: "javascript alert",
      limit: "a JavaScript dialog blocks input; the loop must stop without retrying",
      start: "https://the-internet.herokuapp.com/javascript_alerts",
      goal: 'Click the "Click for JS Alert" button.',
      want: "blocked",
      check: async ({ status }) => status === "blocked",
      cleanup: async ({ call }) => call("handle_dialog", { action: "accept" }).catch(() => {}),
    },
  ],
};
