const { faker } = require('@faker-js/faker');

const INDIAN_FIRST_NAMES_MALE = [
  'Aarav', 'Vivaan', 'Aditya', 'Vihaan', 'Arjun', 'Reyansh', 'Sai', 'Arnav',
  'Dhruv', 'Kabir', 'Ritvik', 'Sahil', 'Mohit', 'Rohan', 'Ankit', 'Amit',
  'Rahul', 'Vikram', 'Suresh', 'Rajesh', 'Deepak', 'Karan', 'Nikhil', 'Gaurav',
];

const INDIAN_FIRST_NAMES_FEMALE = [
  'Ananya', 'Diya', 'Aadhya', 'Priya', 'Sneha', 'Kavya', 'Isha', 'Pooja',
  'Riya', 'Neha', 'Swati', 'Meera', 'Anjali', 'Divya', 'Shruti', 'Nisha',
  'Sonal', 'Tanvi', 'Pallavi', 'Rashmi', 'Sunita', 'Archana', 'Komal', 'Mansi',
];

const INDIAN_LAST_NAMES = [
  'Sharma', 'Patel', 'Singh', 'Mehta', 'Kumar', 'Gupta', 'Joshi', 'Shah',
  'Reddy', 'Nair', 'Iyer', 'Rao', 'Desai', 'Verma', 'Chopra', 'Malhotra',
  'Agarwal', 'Bhat', 'Pillai', 'Saxena', 'Mishra', 'Pandey', 'Tiwari', 'Chauhan',
];

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function formatDate(date) {
  const d = date.getDate().toString().padStart(2, '0');
  const m = (date.getMonth() + 1).toString().padStart(2, '0');
  const y = date.getFullYear();
  return `${d}/${m}/${y}`;
}

function generatePassportNumber() {
  const letter = String.fromCharCode(65 + Math.floor(Math.random() * 26));
  const digits = Math.floor(1000000 + Math.random() * 9000000).toString();
  return letter + digits;
}

function generatePAN() {
  const letters1 = Array.from({ length: 3 }, () =>
    String.fromCharCode(65 + Math.floor(Math.random() * 26))
  ).join('');
  const type = randomFrom(['P', 'C', 'H', 'F', 'A', 'T', 'B', 'L', 'J', 'G']);
  const lastLetter = String.fromCharCode(65 + Math.floor(Math.random() * 26));
  const digits = Math.floor(1000 + Math.random() * 9000).toString();
  return letters1 + type + lastLetter + digits;
}

function generatePhone() {
  const prefix = randomFrom(['7', '8', '9']);
  const rest = Math.floor(100000000 + Math.random() * 900000000).toString();
  return prefix + rest;
}

function generateAdult() {
  const gender = Math.random() > 0.5 ? 'Male' : 'Female';
  const firstName =
    gender === 'Male' ? randomFrom(INDIAN_FIRST_NAMES_MALE) : randomFrom(INDIAN_FIRST_NAMES_FEMALE);
  const lastName = randomFrom(INDIAN_LAST_NAMES);
  const title = gender === 'Male' ? 'Mr' : randomFrom(['Mrs', 'Ms']);

  const now = new Date();
  const minAge = 25;
  const maxAge = 55;
  const age = minAge + Math.floor(Math.random() * (maxAge - minAge));
  const dob = new Date(now.getFullYear() - age, Math.floor(Math.random() * 12), 1 + Math.floor(Math.random() * 28));

  const expiryYears = 2 + Math.floor(Math.random() * 7);
  const passportExpiry = new Date(now.getFullYear() + expiryYears, Math.floor(Math.random() * 12), 1 + Math.floor(Math.random() * 28));

  return {
    type: 'adult',
    title,
    firstName,
    lastName,
    dob: formatDate(dob),
    gender,
    nationality: 'Indian',
    passportNumber: generatePassportNumber(),
    passportExpiry: formatDate(passportExpiry),
    panNumber: generatePAN(),
    phone: generatePhone(),
    email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@gmail.com`,
  };
}

function generateChild() {
  const gender = Math.random() > 0.5 ? 'Male' : 'Female';
  const firstName =
    gender === 'Male' ? randomFrom(INDIAN_FIRST_NAMES_MALE) : randomFrom(INDIAN_FIRST_NAMES_FEMALE);
  const lastName = randomFrom(INDIAN_LAST_NAMES);
  const title = gender === 'Male' ? 'Master' : 'Miss';

  const now = new Date();
  const age = 5 + Math.floor(Math.random() * 7); // 5-11
  const dob = new Date(now.getFullYear() - age, Math.floor(Math.random() * 12), 1 + Math.floor(Math.random() * 28));

  return {
    type: 'child',
    title,
    firstName,
    lastName,
    dob: formatDate(dob),
    gender,
    nationality: 'Indian',
    passportNumber: generatePassportNumber(),
    passportExpiry: null,
    panNumber: null,
    phone: null,
    email: null,
  };
}

function generateInfant() {
  const gender = Math.random() > 0.5 ? 'Male' : 'Female';
  const firstName =
    gender === 'Male' ? randomFrom(INDIAN_FIRST_NAMES_MALE) : randomFrom(INDIAN_FIRST_NAMES_FEMALE);
  const lastName = randomFrom(INDIAN_LAST_NAMES);
  const title = gender === 'Male' ? 'Master' : 'Miss';

  const now = new Date();
  const monthsAgo = 2 + Math.floor(Math.random() * 22); // 2-23 months
  const dob = new Date(now.getTime() - monthsAgo * 30 * 24 * 60 * 60 * 1000);

  return {
    type: 'infant',
    title,
    firstName,
    lastName,
    dob: formatDate(dob),
    gender,
    nationality: 'Indian',
    passportNumber: null,
    passportExpiry: null,
    panNumber: null,
    phone: null,
    email: null,
  };
}

function generateAdultSet(count) {
  return Array.from({ length: count }, () => generateAdult());
}

function generatePassengerSet(scenario) {
  const passengers = [];
  const { adults = 0, children = 0, infants = 0 } = scenario.passengers || {};
  for (let i = 0; i < adults; i++) passengers.push(generateAdult());
  for (let i = 0; i < children; i++) passengers.push(generateChild());
  for (let i = 0; i < infants; i++) passengers.push(generateInfant());
  return passengers;
}

function generateTestPassenger(type = 'adult') {
  return {
    type,
    title: 'Mr',
    firstName: 'EQISTEST',
    lastName: `QA${Date.now().toString().slice(-6)}`,
    dob: type === 'adult' ? '01/01/1990' : '01/01/2015',
    gender: 'Male',
    nationality: 'Indian',
    passportNumber: 'Z9999999',
    passportExpiry: '01/01/2035',
    panNumber: 'AAAAA0000A',
    phone: '9000000000',
    email: 'eqis-test@etrav.in',
  };
}

module.exports = {
  generateAdult,
  generateChild,
  generateInfant,
  generateAdultSet,
  generatePassengerSet,
  generateTestPassenger,
};
