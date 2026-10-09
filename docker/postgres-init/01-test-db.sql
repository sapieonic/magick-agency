-- The test database lives beside the dev one in the same container, so the
-- whole platform needs exactly two ports. Integration suites reset its schema
-- in their global setup and refuse to run against any other database name.
CREATE DATABASE magick_agency_test OWNER magick_agency;
