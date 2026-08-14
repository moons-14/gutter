-- Catalog publication detail ranks releases by their eligible page count. The API runtime role
-- executes that projection but must not receive direct access to the source_pages table.
grant select on reader_eligible_source_pages to gutter_api;

insert into gutter_schema (version) values ('0015_api_reader_page_acl') on conflict (version) do nothing;
