//! Contacts, through the Contacts framework.
//!
//! A contact's note isn't read or written: macOS keeps notes for apps Apple has approved.
#![allow(unsafe_code)]

use std::sync::mpsc;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{Bool, ProtocolObject};
use objc2_contacts::{
    CNAuthorizationStatus, CNContact, CNContactBirthdayKey, CNContactEmailAddressesKey,
    CNContactFamilyNameKey, CNContactGivenNameKey, CNContactIdentifierKey, CNContactJobTitleKey,
    CNContactNicknameKey, CNContactOrganizationNameKey, CNContactPhoneNumbersKey, CNContactStore,
    CNEntityType, CNKeyDescriptor, CNLabelHome, CNLabelOther, CNLabelPhoneNumberMain,
    CNLabelPhoneNumberMobile, CNLabelWork, CNLabeledValue, CNMutableContact, CNPhoneNumber,
    CNSaveRequest,
};
use objc2_foundation::{NSArray, NSCalendar, NSError, NSMutableCopying as _, NSString};
use serde_json::{Value, json};

use crate::args::{Args, shown};
use crate::store::{ASKING, said};

fn status() -> CNAuthorizationStatus {
    // SAFETY: a class method that only reads the saved answer.
    unsafe { CNContactStore::authorizationStatusForEntityType(CNEntityType::Contacts) }
}

fn allowed(status: CNAuthorizationStatus) -> bool {
    status == CNAuthorizationStatus::Authorized || status == CNAuthorizationStatus::Limited
}

/// Whether `LoomWatch` may have the contacts, asking the person first if macOS never has.
pub fn access() -> bool {
    let now = status();
    if now != CNAuthorizationStatus::NotDetermined {
        return allowed(now);
    }
    // SAFETY: a new store, used on this thread only.
    let store = unsafe { CNContactStore::new() };
    let (tell, answer) = mpsc::channel();
    let done = RcBlock::new(move |granted: Bool, _error: *mut NSError| {
        let _ = tell.send(granted.as_bool());
    });
    // SAFETY: the block lives until this function ends, past the answer or the wait.
    unsafe { store.requestAccessForEntityType_completionHandler(CNEntityType::Contacts, &done) };
    answer.recv_timeout(ASKING).unwrap_or(false)
}

pub fn call(action: &str, args: &Args) -> Result<Value, String> {
    if !allowed(status()) {
        return Err(
            "macOS hasn't let LoomWatch see your contacts. The person can allow it in System \
             Settings → Privacy & Security → Contacts → LoomWatch."
                .to_owned(),
        );
    }
    // SAFETY: a new store, used on this thread only.
    let store = unsafe { CNContactStore::new() };
    match action {
        "find_contacts" => find(&store, args),
        "get_contact" => Ok(json!({ "contact": shown_contact(&*named(&store, args)?) })),
        "add_contact" => add(&store, args),
        "change_contact" => change(&store, args),
        "delete_contact" => delete(&store, args),
        _ => Err(format!("There's no action called {action} here.")),
    }
}

fn keys() -> Retained<NSArray<ProtocolObject<dyn CNKeyDescriptor>>> {
    // SAFETY: the framework's own key names, which live as long as the program.
    let names: [&'static NSString; 9] = unsafe {
        [
            CNContactIdentifierKey,
            CNContactGivenNameKey,
            CNContactFamilyNameKey,
            CNContactNicknameKey,
            CNContactOrganizationNameKey,
            CNContactJobTitleKey,
            CNContactPhoneNumbersKey,
            CNContactEmailAddressesKey,
            CNContactBirthdayKey,
        ]
    };
    let keys: Vec<&ProtocolObject<dyn CNKeyDescriptor>> = names
        .iter()
        .map(|name| ProtocolObject::from_ref(*name))
        .collect();
    NSArray::from_slice(&keys)
}

fn label(raw: Option<Retained<NSString>>) -> Option<String> {
    // SAFETY: a class method that turns `_$!<Home>!$_` into "home".
    raw.map(|raw| unsafe { CNLabeledValue::<NSString>::localizedStringForLabel(&raw) }.to_string())
}

fn shown_contact(contact: &CNContact) -> Value {
    // SAFETY: reading the keys `keys()` fetched, on the thread that fetched them.
    unsafe {
        let phones: Vec<Value> = contact
            .phoneNumbers()
            .iter()
            .map(|phone| json!({ "label": label(phone.label()), "number": phone.value().stringValue().to_string() }))
            .collect();
        let emails: Vec<Value> = contact
            .emailAddresses()
            .iter()
            .map(|email| json!({ "label": label(email.label()), "address": email.value().to_string() }))
            .collect();
        let birthday = contact
            .birthday()
            .and_then(|day| NSCalendar::currentCalendar().dateFromComponents(&day))
            .map(|day| {
                shown(day.timeIntervalSince1970())
                    .chars()
                    .take(10)
                    .collect::<String>()
            });
        let text = |value: Retained<NSString>| {
            let value = value.to_string();
            (!value.is_empty()).then_some(value)
        };
        json!({
            "id": contact.identifier().to_string(),
            "givenName": text(contact.givenName()),
            "familyName": text(contact.familyName()),
            "nickname": text(contact.nickname()),
            "organization": text(contact.organizationName()),
            "jobTitle": text(contact.jobTitle()),
            "phones": phones,
            "emails": emails,
            "birthday": birthday,
        })
    }
}

fn find(store: &CNContactStore, args: &Args) -> Result<Value, String> {
    let wanted = args.needed("text")?;
    let limit = args.limit();
    let text = NSString::from_str(&wanted);
    // SAFETY: a predicate and a fetch on the store's own thread.
    let found = unsafe {
        let predicate = if wanted.contains('@') {
            CNContact::predicateForContactsMatchingEmailAddress(&text)
        } else if wanted.chars().filter(char::is_ascii_digit).count() >= 6
            && wanted
                .chars()
                .all(|c| c.is_ascii_digit() || " +-().".contains(c))
        {
            match CNPhoneNumber::phoneNumberWithStringValue(&text) {
                Some(number) => CNContact::predicateForContactsMatchingPhoneNumber(&number),
                None => CNContact::predicateForContactsMatchingName(&text),
            }
        } else {
            CNContact::predicateForContactsMatchingName(&text)
        };
        store.unifiedContactsMatchingPredicate_keysToFetch_error(&predicate, &keys())
    }
    .map_err(|error| format!("Contacts didn't answer: {}", said(&error)))?;
    let listed: Vec<Value> = found
        .iter()
        .take(limit)
        .map(|contact| shown_contact(&contact))
        .collect();
    Ok(json!({ "contacts": listed, "more": found.count() > limit }))
}

fn named(store: &CNContactStore, args: &Args) -> Result<Retained<CNContact>, String> {
    let id = args.needed("id")?;
    // SAFETY: a fetch on the store's own thread.
    unsafe { store.unifiedContactWithIdentifier_keysToFetch_error(&NSString::from_str(&id), &keys()) }
        .map_err(|_| format!("There's no contact with id {id}. Find it again with find_contacts; it may have been deleted."))
}

fn label_for(text: Option<&str>, phone: bool) -> Retained<NSString> {
    // SAFETY: the framework's own label names, which live as long as the program.
    unsafe {
        match text.map(str::to_lowercase).as_deref() {
            Some("home") => Retained::from(CNLabelHome),
            Some("work") => Retained::from(CNLabelWork),
            Some("mobile" | "cell") if phone => Retained::from(CNLabelPhoneNumberMobile),
            Some("main") if phone => Retained::from(CNLabelPhoneNumberMain),
            None | Some("" | "other") => Retained::from(CNLabelOther),
            Some(other) => NSString::from_str(other),
        }
    }
}

/// `field`'s entries, `[{label, number}]` for phones or `[{label, address}]` for emails.
/// One labelled phone number or email address: its label, if any, and the value.
type Entry = (Option<String>, String);

fn entries(args: &Args, field: &str, value: &str) -> Result<Option<Vec<Entry>>, String> {
    let Some(given) = args.0.get(field) else {
        return Ok(None);
    };
    let Some(given) = given.as_array() else {
        return Err(format!(
            "`{field}` should be a list like [{{\"label\": \"work\", \"{value}\": \"…\"}}]."
        ));
    };
    given
        .iter()
        .map(|entry| {
            let text = |key: &str| {
                entry
                    .get(key)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|text| !text.is_empty())
            };
            text(value)
                .map(|found| (text("label").map(str::to_owned), found.to_owned()))
                .ok_or_else(|| format!("Each of `{field}` needs `{value}`."))
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Some)
}

fn fill(contact: &CNMutableContact, args: &Args) -> Result<(), String> {
    let phones = entries(args, "phones", "number")?;
    let emails = entries(args, "emails", "address")?;
    // SAFETY: changing a contact on the thread that made or fetched it.
    unsafe {
        let set = |key: &str, setter: &dyn Fn(&NSString)| {
            if let Some(value) = args.0.get(key).and_then(Value::as_str) {
                setter(&NSString::from_str(value.trim()));
            }
        };
        set("given_name", &|value| contact.setGivenName(value));
        set("family_name", &|value| contact.setFamilyName(value));
        set("nickname", &|value| contact.setNickname(value));
        set("organization", &|value| contact.setOrganizationName(value));
        set("job_title", &|value| contact.setJobTitle(value));
        if let Some(phones) = phones {
            let values = phones
                .iter()
                .map(|(label, number)| {
                    let parsed =
                        CNPhoneNumber::phoneNumberWithStringValue(&NSString::from_str(number))
                            .ok_or_else(|| {
                                format!("{number:?} isn't a phone number Contacts can keep.")
                            })?;
                    Ok(CNLabeledValue::labeledValueWithLabel_value(
                        Some(&label_for(label.as_deref(), true)),
                        &*parsed,
                    ))
                })
                .collect::<Result<Vec<Retained<CNLabeledValue<CNPhoneNumber>>>, String>>()?;
            contact.setPhoneNumbers(&NSArray::from_retained_slice(&values));
        }
        if let Some(emails) = emails {
            let values: Vec<Retained<CNLabeledValue<NSString>>> = emails
                .iter()
                .map(|(label, address)| {
                    CNLabeledValue::labeledValueWithLabel_value(
                        Some(&label_for(label.as_deref(), false)),
                        &*NSString::from_str(address),
                    )
                })
                .collect();
            contact.setEmailAddresses(&NSArray::from_retained_slice(&values));
        }
    }
    Ok(())
}

fn save(store: &CNContactStore, request: &CNSaveRequest, doing: &str) -> Result<(), String> {
    // SAFETY: a save on the store's own thread.
    unsafe { store.executeSaveRequest_error(request) }
        .map_err(|error| format!("Contacts didn't {doing} it: {}", said(&error)))
}

fn add(store: &CNContactStore, args: &Args) -> Result<Value, String> {
    if ["given_name", "family_name", "organization"]
        .iter()
        .all(|key| args.text(key).is_none())
    {
        return Err("Give at least `given_name`, `family_name` or `organization`.".to_owned());
    }
    // SAFETY: a new contact and save request, on this thread.
    let (contact, request) = unsafe { (CNMutableContact::new(), CNSaveRequest::new()) };
    fill(&contact, args)?;
    // SAFETY: as above.
    unsafe { request.addContact_toContainerWithIdentifier(&contact, None) };
    save(store, &request, "add")?;
    Ok(json!({ "added": shown_contact(&contact) }))
}

fn change(store: &CNContactStore, args: &Args) -> Result<Value, String> {
    let contact = named(store, args)?.mutableCopy();
    fill(&contact, args)?;
    // SAFETY: a save request for a contact the store fetched, on its own thread.
    let request = unsafe { CNSaveRequest::new() };
    unsafe { request.updateContact(&contact) };
    save(store, &request, "change")?;
    Ok(json!({ "changed": shown_contact(&contact) }))
}

fn delete(store: &CNContactStore, args: &Args) -> Result<Value, String> {
    let contact = named(store, args)?;
    let gone = shown_contact(&contact);
    let contact = contact.mutableCopy();
    // SAFETY: as above.
    let request = unsafe { CNSaveRequest::new() };
    unsafe { request.deleteContact(&contact) };
    save(store, &request, "delete")?;
    Ok(json!({ "deleted": gone }))
}
